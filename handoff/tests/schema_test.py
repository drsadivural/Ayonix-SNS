"""Real SQLite constraints/transaction tests; not D1 or social API evidence."""
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

SCHEMA = (Path(__file__).resolve().parents[1] / 'reference/schema.sql').read_text()

def seed(conn):
    conn.executescript(SCHEMA)
    conn.executescript("""
    INSERT INTO workspaces VALUES('a','A'),('b','B');
    INSERT INTO products VALUES('pa','a','A product',1),('pb','b','B product',1);
    INSERT INTO connections VALUES('ca','a','linkedin','unit-test-account'),('cb','b','facebook','unit-test-account');
    INSERT INTO quota_periods VALUES('qa','a','2026-10-30T00:00:00Z','2026-11-30T00:00:00Z',20,19,0);
    INSERT INTO quota_periods VALUES('qb','b','2026-10-30T00:00:00Z','2026-11-30T00:00:00Z',20,0,0);
    """)

class Constraints(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        seed(self.db)
    def tearDown(self): self.db.close()
    def target(self,product='pa',connection='ca',period='qa',state='scheduled',receipt=None):
        return self.db.execute('INSERT INTO targets VALUES(?,?,?,?,?,?,?,?,?)',('t','a',product,connection,period,state,'2026-11-01T00:00:00Z',1,receipt))
    def test_cross_tenant_product(self):
        with self.assertRaises(sqlite3.IntegrityError): self.target(product='pb')
    def test_cross_tenant_connection(self):
        with self.assertRaises(sqlite3.IntegrityError): self.target(connection='cb')
    def test_cross_tenant_period(self):
        with self.assertRaises(sqlite3.IntegrityError): self.target(period='qb')
    def test_published_requires_receipt(self):
        with self.assertRaises(sqlite3.IntegrityError): self.target(state='published')
    def test_blank_receipt_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError): self.target(state='published',receipt='   ')
    def test_ledger_cannot_use_other_period(self):
        self.target()
        self.db.execute("INSERT INTO quota_periods VALUES('qa2','a','2026-11-30T00:00:00Z','2026-12-30T00:00:00Z',20,0,0)")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO quota_ledger VALUES('l1','a','t','qa2','reserved')")
    def test_counter_cannot_exceed_allowance(self):
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE quota_periods SET reserved=2 WHERE id='qa'")
    def test_ledger_reservation_unique(self):
        self.target(); self.db.execute("INSERT INTO quota_ledger VALUES('l1','a','t','qa','reserved')")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO quota_ledger VALUES('l2','a','t','qa','reserved')")
    def test_webhook_id_unique(self):
        args=('stripe','evt-unit-test','a','2026-10-30T00:00:00Z',None)
        self.db.execute('INSERT INTO billing_events VALUES(?,?,?,?,?)',args)
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO billing_events VALUES(?,?,?,?,?)',args)
    def test_outbox_revision_unique(self):
        self.target(); self.db.execute("INSERT INTO outbox VALUES('o1','a','t',1,'pending','2026-11-01T00:00:00Z')")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO outbox VALUES('o2','a','t',1,'pending','2026-11-01T00:00:00Z')")
    def test_idempotency_key_scoped(self):
        self.db.execute("INSERT INTO idempotency_records VALUES('a','schedule','key','hash','{}')")
        self.db.execute("INSERT INTO idempotency_records VALUES('b','schedule','key','hash','{}')")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("INSERT INTO idempotency_records VALUES('a','schedule','key','hash','{}')")
    def test_two_database_clients_compete_for_last_unit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'test.sqlite'
            db=sqlite3.connect(path); seed(db); db.close()
            results=[]; failures=[]; barrier=threading.Barrier(2)
            def attempt():
                conn=sqlite3.connect(path,timeout=5)
                try:
                    barrier.wait(timeout=5); conn.execute('BEGIN IMMEDIATE')
                    changed=conn.execute("UPDATE quota_periods SET reserved=reserved+1 WHERE id='qa' AND used+reserved<allowance").rowcount
                    conn.commit(); results.append(changed)
                except Exception as exc: failures.append(str(exc))
                finally: conn.close()
            threads=[threading.Thread(target=attempt) for _ in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(timeout=10)
            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(failures,[]); self.assertEqual(sorted(results),[0,1])

if __name__=='__main__': unittest.main(verbosity=2)
