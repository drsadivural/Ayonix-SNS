import { Link, useParams } from 'react-router';
import { PageHeader } from '../components/ui';
import { TargetDetails } from '../features/targets/TargetDetails';
import { useWorkspace } from '../state/session';

export function TargetPage() {
  const { id = '' } = useParams();
  const workspace = useWorkspace();
  return (
    <>
      <PageHeader
        title="Post details"
        subtitle="Honest status for this destination."
        actions={
          <Link className="btn btn-ghost" to="/dashboard">
            Back to dashboard
          </Link>
        }
      />
      <section className="card">
        <TargetDetails targetId={id} workspace={workspace} />
      </section>
    </>
  );
}
