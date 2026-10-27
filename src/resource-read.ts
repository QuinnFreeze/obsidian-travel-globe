/** Only explicit not-found errors prove absence. Unknown adapter failures may be temporary I/O. */
export function isMissingResource(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const {code,name}=error as {code?:unknown;name?:unknown};
  return code==='ENOENT'||name==='NotFoundError';
}
