import UTIF from 'three/addons/libs/utif.module.js';
// Heavy TIFF decoding is isolated from the globe's UI and render thread.
self.onmessage=async(event:MessageEvent<{buffer:ArrayBuffer;width:number}>)=>{
  try{
    const {buffer,width}=event.data;
    if(width!==4096&&width!==8192)throw Error('无效高清云层尺寸');
    const image=UTIF.decode(buffer)[0];
    if(!image||image.t256?.[0]!==8192||image.t257?.[0]!==4096)throw Error('云层源图尺寸不符');
    UTIF.decodeImage(buffer,image);
    const rgba=UTIF.toRGBA8(image);
    if(rgba.length!==8192*4096*4)throw Error('云层解码失败');
    const source=new OffscreenCanvas(8192,4096),sourceContext=source.getContext('2d');
    if(!sourceContext)throw Error('无法创建云层解码画布');
    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer),8192,4096),0,0);
    const output=new OffscreenCanvas(width,width/2),ctx=output.getContext('2d');
    if(!ctx)throw Error('无法创建云层转换画布');
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,width,width/2);
    source.width=source.height=1;
    const pixels=ctx.getImageData(0,0,width,width/2),p=pixels.data;
    for(let i=0;i<p.length;i+=4){const gray=Math.round(.2126*p[i]+.7152*p[i+1]+.0722*p[i+2]);p[i]=p[i+1]=p[i+2]=gray;}
    ctx.putImageData(pixels,0,0);
    const blob=await output.convertToBlob({type:'image/png'});output.width=output.height=1;
    const result=await blob.arrayBuffer();(self as unknown as Worker).postMessage({result},[result]);
  }catch(error){(self as unknown as Worker).postMessage({error:error instanceof Error?error.message:String(error)});}
};
