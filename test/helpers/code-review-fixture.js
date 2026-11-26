'use strict';

const http=require('node:http');

const initial='a'.repeat(40), base='b'.repeat(40), next='c'.repeat(40), start='d'.repeat(40);
const patch='@@ -2,3 +2,3 @@\n before\n-old\n+new\n after';
const thread='e'.repeat(40), noteId=18;

async function reviewFixture(provider='github',{publication=false,reviewActions=false}={}) {
  const github=provider==='github', token='owned-review-token', repository=github?'owner/example':'group/subgroup/example';
  const path=github?'/api/repos/owner/example/pulls':'/api/projects/group%2Fsubgroup%2Fexample/merge_requests';
  const detail=path+'/7', checked=[], records=[];
  let head=initial, mutate=false, allowChecks=true, dropNextReply=false;
  const published=[], actions=[], replies=[];
  const comment={body:'Existing line comment',user:{login:'reviewer'},author:{username:'reviewer'},path:'src/main/A.java',line:3,
    commit_id:initial,resolved:false,position:{new_path:'src/main/A.java',new_line:3,head_sha:initial},
    ...(reviewActions&&{id:noteId,updated_at:'2026-01-01T00:00:00Z'})};
  const card=()=>github?{number:7,title:'Fix a generated method',body:'Tracks #41 and #16.',user:{login:'author'},state:'open',head:{sha:head},base:{sha:base}}:
    {iid:7,title:'Fix a generated method',description:'Tracks #41 and #16.',author:{username:'author'},state:'opened',sha:head,
      diff_refs:{head_sha:head,base_sha:base,start_sha:start}};
  const server=http.createServer(async(request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    records.push({method:request.method,path:url.pathname,page:url.searchParams.get('page')});
    const accept=github?request.headers.authorization==='Bearer '+token:request.headers['private-token']===token;
    if(!accept){response.writeHead(401).end();return;}
    if(reviewActions&&request.method!=='GET'){
      const chunks=[];
      for await(const chunk of request) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      const replyPath=github?detail+'/comments/'+noteId+'/replies':detail+'/discussions/'+thread+'/notes';
      const editPath=github?path+'/comments/'+noteId:replyPath+'/'+noteId;
      let value;
      if(request.method==='POST'&&url.pathname===replyPath){
        value={...comment,id:noteId+1+replies.length,body:input.body,...(github&&{in_reply_to_id:noteId})};
        replies.push(value);
      }else if(request.method===(github?'PATCH':'PUT')&&url.pathname===editPath){
        changeNote(input.body);
        value=comment;
      }else if(request.method==='POST'&&github&&url.pathname===detail+'/reviews'){
        const states={APPROVE:'APPROVED',COMMENT:'COMMENTED',REQUEST_CHANGES:'CHANGES_REQUESTED'};
        if(input.commit_id!==head||!states[input.event]){response.writeHead(422).end();return;}
        value={id:41,body:input.body,commit_id:head,state:states[input.event]};
      }else if(request.method==='POST'&&!github&&url.pathname===detail+'/approve'){
        if(input.sha!==head){response.writeHead(409).end();return;}
        value={iid:7,approved_by:[{user:{username:'reviewer'}}]};
      }else if(request.method==='POST'&&!github&&url.pathname===detail+'/discussions'){
        value={id:'f'.repeat(40),notes:[{id:41,body:input.body}]};
      }else{response.writeHead(404).end();return;}
      actions.push({input,method:request.method,path:url.pathname});
      if(dropNextReply){dropNextReply=false;request.socket.destroy();return;}
      response.writeHead(request.method==='POST'?201:200,{'Content-Type':'application/json'}).end(JSON.stringify(value));
      return;
    }
    if(request.method==='POST'&&publication&&url.pathname===detail+(github?'/comments':'/discussions')){
      let input;
      try {
        const chunks=[];
        for await(const chunk of request) chunks.push(chunk);
        input=JSON.parse(Buffer.concat(chunks));
      }catch{response.writeHead(400).end();return;}
      if(github?input.commit_id!==head:input.position?.head_sha!==head){
        response.writeHead(422).end();return;
      }
      const note=github?{
        id:234+published.length,body:input.body,path:input.path,line:input.line,commit_id:input.commit_id
      }:{id:(234+published.length).toString(16).padStart(40,'0'),
        notes:[{body:input.body,position:input.position}]};
      published.push({input,note});
      if(dropNextReply){dropNextReply=false;request.socket.destroy();return;}
      response.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify(note));
      return;
    }
    if(request.method!=='GET'){response.writeHead(405).end();return;}
    let value;
    if(url.pathname===path){
      if(url.searchParams.get('page')==='1')response.setHeader(github?'link':'x-next-page',github?'<http://127.0.0.1/never-follow>; rel="next"':'2');
      value=[card()];
    }else if(url.pathname===detail)value=card();
    else if(url.pathname===detail+(github?'/files':'/diffs')){
      if(publication&&url.searchParams.get('page')==='2'){
        value=github?[{filename:'src/main/B.java',previous_filename:'src/old/B.java',status:'renamed',patch}]:
          [{new_path:'src/main/B.java',old_path:'src/old/B.java',renamed_file:true,diff:patch}];
      }else{
        value=github?[{filename:'src/main/A.java',status:'modified',patch},{filename:'payload.bin',status:'modified'}]:
          [{new_path:'src/main/A.java',diff:patch},{new_path:'payload.bin',collapsed:true}];
        if(publication)response.setHeader(github?'link':'x-next-page',github?'<http://127.0.0.1/never-follow>; rel="next"':'2');
      }
      if(mutate)head=next;
    }else if(url.pathname===detail+(github?'/comments':'/discussions')){
      if(publication&&url.searchParams.get('page')==='2'){
        const additional={...comment,body:'Additional discussion page'};
        value=github?[additional,...published.map(item=>item.note)]:[ {notes:[additional]},...published.map(item=>item.note) ];
      }else{
        value=github?[comment,...replies]:[{...(reviewActions&&{id:thread}),notes:[comment,...replies]}];
        if(publication)response.setHeader(github?'link':'x-next-page',github?'<http://127.0.0.1/never-follow>; rel="next"':'2');
      }
    }
    else if(url.pathname===detail+'/pipelines'||url.pathname==='/api/repos/owner/example/commits/'+head+'/check-runs'){
      checked.push(url.pathname);
      if(!allowChecks){response.writeHead(403).end();return;}
      const check={id:22,name:'Compile',ref:'compile',status:'success',conclusion:'success'};
      value=github?{check_runs:[check]}:[check];
    }else{response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(value));
  });
  function changeNote(body){
    comment.body=body;
    comment.updated_at='2026-01-01T00:00:01Z';
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {profile:{provider,repository,token,endpoint:'http://127.0.0.1:'+server.address().port+'/api/'},records,checked,published,actions,changeNote,
    loseNextReply(){dropNextReply=true;},
    mutateDuringRead(){mutate=true;},hideChecks(){allowChecks=false;},
    async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}};
}

module.exports={reviewFixture,initial,base,start,patch,noteId,thread};
