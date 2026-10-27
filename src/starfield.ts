/** Small deterministic cube textures: a static monochrome sky with no frame timer or network request. */
export function createStarfield(size=1024,theme:'light'|'dark'='dark',background=theme==='dark'?'#050505':'#f5f5f5'){
 const names=['positiveX','negativeX','positiveY','negativeY','positiveZ','negativeZ'] as const;
 return Object.fromEntries(names.map((name,index)=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d');if(!ctx)return [name,canvas];
  ctx.fillStyle=background;ctx.fillRect(0,0,size,size);
  let seed=0x1234567+index*7919;const next=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<155;i++){
   const x=2+next()*(size-4),y=2+next()*(size-4),bright=next(),radius=bright>.97?.85:bright>.82?.55:.4;
   ctx.fillStyle=theme==='dark'?'rgba(255,255,255,'+(.18+bright*.67)+')':'rgba(0,0,0,'+(.08+bright*.24)+')';ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
  }
  return [name,canvas];
 }));
}
