// Hold a screen lock only for opted-in playback in a visible document.
export function createScreenWakeLock({wakeLock, enabled=false, onChange=()=>{}}={}){
 const supported=typeof wakeLock?.request==='function';
 let optedIn=!!enabled, playing=false, visible=true, sentinel=null, pending=false, blocked=false, generation=0;
 const wanted=()=>supported&&optedIn&&playing&&visible;
 function snapshot(){
  const status=!supported?'unsupported':!optedIn?'off':!playing?'paused':!visible?'hidden':sentinel&&!sentinel.released?'active':pending?'pending':blocked?'blocked':'paused';
  return {supported,enabled:optedIn,status};
 }
 const publish=()=>onChange(snapshot());
 async function release(lock){try{await lock?.release();}catch{ /* The browser may already have released it. */ }}
 async function reconcile(){
  if(!wanted()){
   generation++;blocked=false;
   const previous=sentinel;sentinel=null;publish();
   await release(previous);return;
  }
  if(sentinel&&!sentinel.released||pending){publish();return;}
  const requestGeneration=generation;
  pending=true;blocked=false;publish();
  try{
   const lock=await wakeLock.request('screen');
   // A pause, hidden tab or opt-out can happen while the request is pending.
   if(requestGeneration!==generation||!wanted()){await release(lock);}
   else if(lock.released){blocked=true;}
   else{
    sentinel=lock;
    lock.addEventListener('release',()=>{
     if(sentinel!==lock)return;
     sentinel=null;blocked=wanted();publish();
     // Don't fight a system or battery-policy release with a retry loop.
    },{once:true});
   }
  }catch{if(requestGeneration===generation&&wanted())blocked=true;}
  finally{
   pending=false;publish();
   if(requestGeneration!==generation&&wanted())void reconcile();
  }
 }
 publish();
 return {
  getState:snapshot,
  setEnabled(value){optedIn=!!value;return reconcile();},
  setPlaying(value){playing=!!value;return reconcile();},
  setVisible(value){visible=!!value;return reconcile();}
 };
}
