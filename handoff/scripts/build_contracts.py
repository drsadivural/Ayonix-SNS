from pathlib import Path
import json

ROOT=Path(__file__).resolve().parents[1]
string={'type':'string','minLength':1}
identifier={'type':'string','minLength':1,'maxLength':128}
platform={'type':'string','enum':['linkedin','facebook','instagram','tiktok','youtube']}
def obj(properties,required=()):
    return {'type':'object','properties':properties,'required':list(required),'additionalProperties':False}
def array(items,minimum=0,maximum=100):return {'type':'array','items':items,'minItems':minimum,'maxItems':maximum}
scope_read='sns:read'
tools=[]
def tool(name,description,properties,required=(),scope=scope_read,write=False,destructive=False):
    tools.append({'name':name,'description':description,'inputSchema':obj(properties,required),'requiredScope':scope,
      'annotations':{'readOnlyHint':not write,'destructiveHint':destructive,'idempotentHint':True,'openWorldHint':name in ['confirm_schedule','cancel_schedule','ingest_media','request_product_research']},
      'securitySchemes':[{'type':'oauth2','scopes':[scope]}]})

tool('get_workspace_status','Read current authorized workspace capabilities and entitlement; never return purchase links.',{})
tool('list_products','Read authorized product profiles and approved claims.',{'cursor':identifier})
tool('list_connections','Read actual social accounts and granted capabilities. Never include tokens.',{'product_id':identifier})
tool('create_campaign_draft','Persist a campaign draft. Does not publish or schedule.',{'product_id':identifier,'goal':string,'audience':string,'language':{'type':'string','minLength':2,'maxLength':35},'idempotency_key':identifier},['product_id','goal','audience','language','idempotency_key'],'sns:draft',True)
target=obj({'platform':platform,'connection_id':identifier,'format':{'type':'string','enum':['text','link','image','video','reel','carousel','photo']},'caption':{'type':'string','maxLength':10000},'asset_ids':array(identifier,0,35),'title':{'type':'string','maxLength':100},'link_url':{'type':'string','format':'uri'}},['platform','connection_id','format','caption','asset_ids'])
tool('prepare_post','Persist exact per-destination content for a campaign. Media must be owned validated assets. Does not approve publishing.',{'campaign_id':identifier,'targets':array(target,1,100),'idempotency_key':identifier},['campaign_id','targets','idempotency_key'],'sns:draft',True)
entry=obj({'post_id':identifier,'revision':{'type':'integer','minimum':1},'scheduled_at_utc':{'type':'string','format':'date-time','pattern':'Z$'},'timezone':string},['post_id','revision','scheduled_at_utc','timezone'])
tool('preview_schedule','Validate exact revisions, timezones, account formats, quota and required consent. Returns expiring bound preview and per-target costs; does not confirm.',{'entries':array(entry,1,100)},['entries'],'sns:schedule')
tool('confirm_schedule','Confirm only the reviewed expiring preview. Reserves quota and persists durable schedule; unavailable consent remains awaiting approval. Reusing a key with changed input conflicts.',{'preview_token':string,'confirmed':{'type':'boolean','const':True},'idempotency_key':identifier},['preview_token','confirmed','idempotency_key'],'sns:schedule',True)
tool('list_schedule','Read authorized scheduled targets and honest per-provider state.',{'cursor':identifier,'product_id':identifier,'status':string,'from_utc':{'type':'string','format':'date-time'},'to_utc':{'type':'string','format':'date-time'}})
tool('cancel_schedule','Request cancellation of a selected schedule version. Submitted/unknown outcomes require reconciliation; never promise deletion of a published post.',{'schedule_id':identifier,'expected_version':{'type':'integer','minimum':1},'idempotency_key':identifier},['schedule_id','expected_version','idempotency_key'],'sns:cancel',True,True)
tool('get_post_status','Read provider-verified IDs, URLs and state. Processing is not published.',{'post_id':identifier},['post_id'])
tool('get_report','Read actual authorized metrics and sources, with unsupported values null.',{'product_id':identifier,'platforms':array(platform,0,5),'from_utc':{'type':'string','format':'date-time'},'to_utc':{'type':'string','format':'date-time'}},['from_utc','to_utc'])
tool('save_product_profile','Create or revise a draft product definition from the conversation. New claims remain unapproved until explicitly reviewed.',{'product_id':identifier,'expected_version':{'type':'integer','minimum':1},'name':string,'audience':string,'language':string,'tone':string,'source_urls':array({'type':'string','format':'uri'},0,20),'proposed_claims':array(string,0,50),'prohibited_claims':array(string,0,50),'idempotency_key':identifier},['name','audience','language','tone','source_urls','proposed_claims','prohibited_claims','idempotency_key'],'sns:draft',True)
tool('approve_product_profile','Approve the exact reviewed product version and evidence-backed claims; cannot approve unreviewed web-derived instructions.',{'product_id':identifier,'expected_version':{'type':'integer','minimum':1},'confirmed':{'type':'boolean','const':True},'idempotency_key':identifier},['product_id','expected_version','confirmed','idempotency_key'],'sns:schedule',True)
tool('ingest_media','Ingest a user-selected available HTTPS media URL into owned validated storage. Server enforces size/SSRF/rights checks. If ChatGPT cannot provide a retrievable URL, return an authenticated upload handoff; never pretend an inaccessible file was uploaded.',{'source_url':{'type':'string','format':'uri'},'filename':string,'product_id':identifier,'rights_confirmed':{'type':'boolean','const':True},'idempotency_key':identifier},['filename','product_id','rights_confirmed','idempotency_key'],'sns:draft',True)
tool('list_assets','Read owned validated media assets; never expose storage secrets.',{'product_id':identifier,'cursor':identifier})
tool('request_product_research','Run an entitled bounded learning, competitor or similar-product research job; results have citations and remain proposed until reviewed.',{'product_id':identifier,'kind':{'type':'string','enum':['auto_learn','competitor_check','similar_research']},'source_urls':array({'type':'string','format':'uri'},0,20),'question':string,'idempotency_key':identifier},['product_id','kind','idempotency_key'],'sns:draft',True)
tool('get_research_status','Read actual research job status, dated sources and proposed changes; no fabricated completion.',{'job_id':identifier},['job_id'])
(ROOT/'contracts/mcp-tools.json').write_text(json.dumps({'contractVersion':'2026-10-30.1','transport':'streamable-http','tools':tools,'responseRequirements':{'all':['request_id','safe status','authorized workspace context'],'preview_schedule':['preview_token','expires_at','revisions','local_and_utc_times','quota_cost','approval_requirements'],'confirm_schedule':['schedule_id','version','target_ids','states'],'get_post_status':['per-target status','real receipt when available','verified URL when available','safe error','next_action'],'get_report':['period','metrics','source_names','retrieved_at','definitions','unavailable_fields']},'implementationNote':'Contract metadata requiredScope and securitySchemes must be mapped into the maintained SDK supported registration metadata. Runtime auth remains mandatory; do not send invented protocol fields.'},indent=2))
print(f'Wrote {len(tools)} tool schemas')
