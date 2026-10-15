const {createHmac}=require('node:crypto');
(async()=>{
  const {TENANT:tenant,SOURCE:source='github',REPOSITORY:repository,WEBHOOK_SECRET:secret}=process.env;
  if(!tenant||!repository||!secret) throw new Error('Configure TENANT, REPOSITORY (owner/name) and WEBHOOK_SECRET');
  const [owner,repo]=repository.split('/');
  const number=Number(process.env.ISSUE_NUMBER||1),id=Number(process.env.ISSUE_ID||Date.now());
  const payload={action:'opened',repository:{name:repo,full_name:`${owner}/${repo}`,default_branch:process.env.DEFAULT_BRANCH||'main',owner:{login:owner}},issue:{id,number,title:'Add a tested greeting function',body:'Add a hello(name) function and a unit test following existing project conventions.',state:'open',html_url:`https://github.com/${owner}/${repo}/issues/${number}`,author_association:'OWNER'}};
  const raw=JSON.stringify(payload),signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  const url=process.argv[2]||`http://localhost:3000/webhooks/${tenant}/${source}`;
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-github-event':'issues','x-hub-signature-256':signature},body:raw});
  console.log(response.status,await response.text());if(response.status!==202)process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
