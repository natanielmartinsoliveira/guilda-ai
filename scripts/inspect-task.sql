-- psql: \set task_id 'UUID-RETURNED-BY-WEBHOOK'
SELECT id,status,stage,attempts,error,result FROM tasks WHERE id=:'task_id';
SELECT agent,provider,status,command,"exitCode","startedAt","finishedAt",stderr FROM agent_runs WHERE "taskId"=:'task_id' ORDER BY "startedAt";
SELECT number,url,state FROM pull_requests WHERE "taskId"=:'task_id';
