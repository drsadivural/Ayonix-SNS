"""Deterministic editable UI mockups. Requires reportlab and pdftoppm.
Not app screenshots, provider test results or production data.
"""
from pathlib import Path
import json
import subprocess
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'design'; OUT.mkdir(exist_ok=True)
pdfmetrics.registerFont(TTFont('UI','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('UIB','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
W,H=1440,1000
BLUE='#176BFF'; NAVY='#10233F'; GRAY='#66788F'; BORDER='#E1E8F1'
c=canvas.Canvas(str(OUT/'design-overview.pdf'),pagesize=(W,H))
c.setTitle('Ayonix-SNS — authoritative UI mockups')
dark=False
def rect(x,y,w,h,fill,r=12,stroke=None):
    c.setFillColor(fill); c.setStrokeColor(stroke or fill)
    c.roundRect(x,H-y-h,w,h,r,fill=1,stroke=bool(stroke))
def text(x,y,value,size=15,color=None,bold=False):
    c.setFillColor(color or ('#EAF1FC' if dark else NAVY)); c.setFont('UIB' if bold else 'UI',size)
    c.drawString(x,H-y-size,str(value))
def line(x,y,x2,y2,color=BORDER,width=1):
    c.setStrokeColor(color);c.setLineWidth(width);c.line(x,H-y,x2,H-y2)
def button(x,y,label,w=150,primary=True):
    rect(x,y,w,43,BLUE if primary else ('#1C2C45' if dark else '#EFF5FF'),8)
    text(x+15,y+12,label,13,'#FFFFFF' if primary else ('#DCE8FA' if dark else BLUE),True)
def card(x,y,w,h,title=None):
    rect(x,y,w,h,'#14243A' if dark else '#FFFFFF',14,'#24374F' if dark else BORDER)
    if title:text(x+22,y+20,title,16,bold=True)
def pill(x,y,label,color='#087D63',bg='#E7F7F0',w=125):
    rect(x,y,w,29,bg,8);text(x+10,y+7,label,11,color,True)
def field(x,y,w,label,value):
    text(x,y,label,12,GRAY);rect(x,y+25,w,48,'#14243A' if dark else '#FFFFFF',8,BORDER);text(x+14,y+39,value,14)
def chart(x,y,w,h):
    for i in range(5):line(x,y+i*h/4,x+w,y+i*h/4,'#273951' if dark else '#EDF1F7')
    points=[.78,.67,.72,.48,.52,.57,.36,.42,.19,.27,.14,.2,.06]
    p=c.beginPath();p.moveTo(x,H-y-h)
    for i,v in enumerate(points):p.lineTo(x+i*w/(len(points)-1),H-y-v*h)
    p.lineTo(x+w,H-y-h);p.close();c.setFillColor('#173C6E' if dark else '#EAF2FF');c.drawPath(p,fill=1,stroke=0)
    for i in range(len(points)-1):line(x+i*w/12,y+points[i]*h,x+(i+1)*w/12,y+points[i+1]*h,BLUE,3)
    text(x,y+h+14,'Oct 01',11,GRAY);text(x+w-50,y+h+14,'Oct 30',11,GRAY)
def shell(title,sub,active=None,is_dark=False):
    global dark;dark=is_dark
    rect(0,0,W,H,'#0B1729' if dark else '#F5F8FC',0)
    rect(0,0,218,H,'#0E1D31' if dark else '#FFFFFF',0)
    rect(28,27,35,35,BLUE,9);text(38,32,'A',22,'#FFFFFF',True);text(76,35,'Ayonix-SNS',16,bold=True)
    for i,label in enumerate(['Dashboard','Connectors','Billings','Reports','Settings']):
        y=117+i*59
        if label==(active or title):rect(17,y-7,184,46,'#193C6A' if dark else '#EAF2FF',9)
        text(37,y+5,label,15,BLUE if label==(active or title) else None,label==(active or title))
    text(30,860,'AYONIX WORKSPACE',10,GRAY,True);text(30,884,'Dr. Sadi Vural',13,bold=True);text(30,912,'Australia/Melbourne',11,GRAY)
    text(252,35,title,29,bold=True);text(254,83,sub,14,GRAY)
    pill(1165,40,'Design preview',BLUE,'#EAF2FF',168)
    text(254,969,'DESIGN ONLY  /  Example data  /  Not a live connected application',11,GRAY)
def finish():c.showPage()

def dashboard(is_dark=False):
    shell('Dashboard','Plan in ChatGPT. Publish with Ayonix.',is_dark=is_dark)
    button(1198,125,'New schedule',183);text(255,136,'All products     |     All channels     |     Last 30 days',14,GRAY)
    for i,(name,value,note) in enumerate([('Published','38','60 monthly limit'),('Scheduled','12','Capacity reserved'),('Impressions','124,820','Available channels only'),('Engagements','4,218','See metric definitions')]):
        x=254+i*287;card(x,194,266,130);text(x+20,212,name,13,GRAY);text(x+20,244,value,32,bold=True);text(x+20,292,note,11,GRAY)
    card(254,348,735,300,'Audience engagement');chart(282,415,675,180)
    card(1010,348,372,300,'By channel')
    for i,(name,amount) in enumerate([('LinkedIn',.88),('Facebook',.63),('Instagram',.76),('TikTok',.42),('YouTube',.55)]):
        yy=406+i*42;text(1033,yy,name,12);rect(1150,yy+1,200,14,'#DDE9FA',5);rect(1150,yy+1,200*amount,14,BLUE,5)
    card(254,672,1128,255,'Upcoming posts');text(278,728,'TIME / MELBOURNE',11,GRAY,True);text(530,728,'CONTENT',11,GRAY,True);text(1060,728,'STATUS',11,GRAY,True)
    for i,(date,title,channel,status) in enumerate([('Nov 03, 09:00','Retail protection, from camera to action','LinkedIn','Scheduled'),('Nov 04, 09:00','A practical guide to edge video analytics','Facebook','Scheduled'),('Nov 05, 10:30','Your original product video','TikTok','Needs approval')]):
        yy=762+i*50;line(275,yy-10,1355,yy-10);text(279,yy,date,13);text(530,yy,title,13);text(530,yy+21,channel,10,GRAY);pill(1060,yy,status,w=165)
    finish()

dashboard()
shell('Connectors','Connect your accounts. See what each channel supports.')
card(254,135,1128,110);rect(277,159,52,52,'#E6F5F0',12);text(288,174,'AI',19,'#087D63',True);text(348,158,'ChatGPT',19,bold=True);text(348,194,'Use your existing entitled Ayonix account to connect.',13,GRAY);button(1157,168,'Setup guide',185)
channels=[('LinkedIn','Page / member publishing','Reconnect required'),('Facebook','Pages publishing','Connected'),('Instagram','Professional account','Connected'),('TikTok','Creator consent per post','Review pending'),('YouTube','Video uploads and metrics','Not connected')]
for i,(name,desc,status) in enumerate(channels):
    x=254+(i%3)*383;y=277+(i//3)*267;card(x,y,362,242);rect(x+23,y+23,48,48,'#EAF2FF',12);text(x+36,y+35,name[0],23,BLUE,True);text(x+88,y+32,name,20,bold=True);text(x+24,y+94,desc,12,GRAY);pill(x+24,y+126,status,w=205);button(x+24,y+176,'Reconnect' if i==0 else 'Manage' if i in [1,2] else 'View requirements' if i==3 else 'Connect',240,primary=i not in [1,2,3])
finish()
shell('Billings','Monthly subscriptions in USD. Tax added where applicable.')
for i,(name,price,posts,products,features) in enumerate([('Basic',49,20,1,False),('Standard',99,60,3,True),('Premium',199,120,10,True),('Custom',None,None,None,None)]):
    x=254+i*287;card(x,144,266,342);text(x+22,170,name,21,bold=True);text(x+22,219,'$49–$1,000' if price is None else '$'+str(price),28,bold=True);text(x+22,259,'per month',12,GRAY)
    rows=([f'{posts} posts / month',f'{products} product'+('s' if products!=1 else ''),'All five networks']+(['Auto learn + research'] if features else ['Core publishing'])) if price else ['Choose capacity','Choose product count','Select AI features','Maximum $1,000 / month']
    for j,row in enumerate(rows):text(x+22,294+j*29,row,12)
    button(x+22,427,'Customize' if price is None else 'Choose plan',222,primary=i==1)
card(254,513,1128,367,'Build your Custom plan')
for x,label,value in [(280,'Posts / month','1,000  (+$420)'),(640,'Active products','50  (+$160)')]:field(x,580,320,label,value)
for i,label in enumerate(['Auto learn  +$99','Competitor check  +$129','Similar research  +$143']):
    rect(280+i*350,689,22,22,BLUE,5);text(286+i*350,691,'✓',14,'#FFFFFF');text(314+i*350,692,label,13)
line(278,748,1357,748);text(280,782,'All selected',15,GRAY);text(1010,774,'$1,000 / month',27,bold=True);text(280,826,'Includes base $49. Pre-tax subscription maximum.',12,GRAY);finish()
shell('Reports','Understand performance, with clear source definitions.')
text(254,140,'All products    |    All channels    |    Oct 01–30, 2026',14,GRAY);button(1030,124,'Export CSV',160,False);button(1205,124,'Export PDF',176)
card(254,200,738,351,'Impressions over time');chart(283,274,674,211)
card(1013,200,369,351,'Data coverage')
for i,(name,value) in enumerate([('LinkedIn','Updated 2h ago'),('Facebook','Updated 2h ago'),('Instagram','Updated 3h ago'),('TikTok','Not available'),('YouTube','Not connected')]):text(1036,267+i*49,name,13,bold=True);text(1172,269+i*49,value,10,GRAY)
card(254,580,1128,300,'Top posts');text(280,640,'POST',11,GRAY,True);text(900,640,'IMPRESSIONS',11,GRAY,True);text(1125,640,'ENGAGEMENTS',11,GRAY,True)
for i,(name,impressions,eng) in enumerate([('Retail protection, from camera to action','24,180','892'),('Edge analytics without the server room','18,420','612'),('AI agents that follow through','16,300','540')]):
    yy=684+i*57;line(279,yy-13,1355,yy-13);text(280,yy,name,14);text(915,yy,impressions,14);text(1150,yy,eng,14)
text(279,849,'Unsupported metrics are unavailable, never counted as zero.',11,GRAY);finish()
shell('Settings','Your workspace, products, team and controls.')
text(255,139,'Workspace     Products     Members     Events     Security',14,BLUE,True)
card(254,187,690,470,'Workspace');field(279,254,637,'Workspace name','Ayonix');field(279,352,637,'Timezone','Australia/Melbourne');field(279,450,637,'Notifications','Publishing failures and approvals');button(279,570,'Save changes',200)
card(969,187,413,470,'Products');text(993,260,'Ayonix Shoplifter',16,bold=True);text(993,290,'Approved claims and owned assets',12,GRAY);line(992,329,1356,329);text(993,353,'Ayonix Video Analytics',16,bold=True);text(993,383,'Source review required',12,GRAY);button(993,567,'Manage products',235,False)
card(254,685,1128,215,'Recent events');text(280,750,'09:42   Schedule approved',14);text(280,794,'09:38   Instagram token renewed',14);text(910,750,'Actor: workspace owner',12,GRAY);text(910,794,'Actor: system',12,GRAY);finish()

shell('Create your account','Independent Ayonix website registration. No payment is requested in ChatGPT OAuth.','Connectors')
card(450,156,680,643,'Start your Ayonix workspace');button(483,230,'Continue with Google',610,False);text(733,296,'or',13,GRAY)
field(483,340,610,'Work email','');field(483,441,610,'Password','');text(484,545,'Agree to Terms and Privacy Policy',13,GRAY);button(483,605,'Create account',610);text(483,691,'Already registered? Sign in',13,BLUE);finish()
shell('Choose your plan','Website onboarding: Account → Plan → Channels.','Billings')
card(350,184,890,530,'Get started with Standard');text(388,265,'$99 / month',44,bold=True)
for i,row in enumerate(['60 destination publications each month','3 active products · All five networks','Auto learn · Competitor check · Similar-product research']):text(388,354+i*47,row,17)
button(389,548,'Continue to secure checkout',425);text(389,617,'Payment is confirmed only after a verified Stripe webhook.',13,GRAY);finish()
shell('Connect to ChatGPT','Sign in and approve access to your existing account.','Connectors')
card(410,167,730,635,'Authorize Ayonix-SNS');text(445,252,'Workspace: Ayonix',22,bold=True);text(445,308,'ChatGPT requests permission to:',15,GRAY)
for i,row in enumerate(['Read products, connections and reports','Create content drafts','Confirm schedules you approve','Cancel schedules you select']):text(445,361+i*49,row,17)
button(445,610,'Approve connection',325);button(792,610,'Deny',205,False);text(445,702,'No payment details or social access tokens are shared.',13,GRAY);finish()
shell('Schedule a post','Review each destination before confirming.','Dashboard')
card(254,144,700,734,'Content');text(278,211,'LinkedIn     Facebook     Instagram     TikTok     YouTube',13,BLUE,True);field(278,262,650,'Product','Ayonix Shoplifter');text(279,369,'Caption',12,GRAY);rect(278,399,650,160,'#F5F8FC',10,BORDER);text(298,421,'Protect your stores with practical, real-time alerts.',16);text(298,457,'Built for existing camera infrastructure.',16);button(278,585,'Upload owned media',260,False);field(278,670,650,'Schedule / Melbourne','03 Nov 2026 09:00  (02 Nov 22:00 UTC)')
card(977,144,405,734,'Review');text(1000,222,'2 destination publications',18,bold=True);text(1000,269,'LinkedIn + Facebook',15);text(1000,315,'12 / 60 reserved this cycle',13,GRAY);pill(1000,367,'Approval required',w=235);text(1000,431,'Content and time are bound',14);text(1000,459,'to this approval revision.',14);button(1000,688,'Confirm schedule',355);button(1000,747,'Save draft',355,False);finish()
shell('TikTok approval','Complete required creator settings before scheduling.','Dashboard')
card(350,153,892,737,'Creator: Ayonix demo account');text(383,226,'Preview and edit the original photo or video.',17);field(383,280,825,'Privacy / current creator options','Select privacy (no default)');field(383,380,825,'Interactions','Comments / Duet / Stitch — choose allowed options');field(383,480,825,'Commercial content disclosure','Off — choose if this promotes a brand or service');text(383,600,'Review the platform music / branded-content terms.',15,GRAY);text(383,647,'Consent is saved for this exact content and settings.',15);button(383,736,'Approve this content',390);button(795,736,'Return to draft',390,False);finish()
shell('Post details','Honest status for every destination.','Dashboard')
card(254,155,1128,580,'Retail protection, from camera to action')
for i,(channel,status,description) in enumerate([('LinkedIn','Published','Provider receipt and verified URL appear here in production.'),('Facebook','Outcome unknown','Do not retry blindly. Reconcile the provider outcome first.'),('TikTok','Needs approval','Awaiting creator settings and content consent.')]):
    yy=247+i*149;text(283,yy,channel,22,bold=True);pill(1000,yy,status,w=245);text(283,yy+49,description,15,GRAY);line(281,yy+106,1350,yy+106)
text(283,672,'Example states only. No real provider IDs are represented in this mockup.',12,GRAY);finish()
dashboard(True)

# Dedicated narrow layout, still a full PDF page for printable overview.
dark=False;rect(0,0,W,H,'#EAF1FA',0);rect(485,45,470,910,'#FFFFFF',28,BORDER);text(516,78,'Ayonix-SNS',23,bold=True);text(516,139,'Dashboard',29,bold=True);text(516,185,'Design preview / Example data',12,GRAY)
for i,(name,value) in enumerate([('Published','38'),('Scheduled','12')]):
    card(513+i*216,241,198,125);text(529+i*216,258,name,13,GRAY);text(529+i*216,292,value,32,bold=True)
card(513,391,414,255,'Engagement');chart(534,456,367,131);card(513,671,414,167,'Next post');text(535,726,'Nov 03, 09:00 Melbourne',15,bold=True);text(535,762,'LinkedIn · Scheduled',13,GRAY);text(513,892,'Dash.    Connect.    Billings    Reports    Settings',12,BLUE);finish()
c.save()

names=['dashboard','connectors','billings','reports','settings','register','onboarding','chatgpt-consent','schedule','tiktok-approval','post-details','dashboard-dark','dashboard-mobile']
for page,name in enumerate(names,1):
    subprocess.run(['pdftoppm','-f',str(page),'-l',str(page),'-scale-to','1440','-png','-singlefile',str(OUT/'design-overview.pdf'),str(OUT/name)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
(OUT/'screens.json').write_text(json.dumps([{'name':n,'file':n+'.png'} for n in names],indent=2))
print(f'Generated {len(names)} deterministic mockups and design-overview.pdf')
