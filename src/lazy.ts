// Share concurrent loads; release failures so a later attempt can retry (e.g. iCloud download).
export function lazyResource<T>(load:()=>Promise<T>):()=>Promise<T> {
  let pending:Promise<T>|undefined;
  return ()=>{
    if(!pending){
      const work=Promise.resolve().then(load);pending=work;
      void work.catch(()=>{if(pending===work)pending=undefined;});
    }
    return pending;
  };
}
