declare module 'three/addons/libs/utif.module.js' {
  interface Image {t256?:number[];t257?:number[];width:number;height:number}
  const UTIF:{decode(data:ArrayBuffer):Image[];decodeImage(data:ArrayBuffer,image:Image):void;toRGBA8(image:Image):Uint8Array};
  export default UTIF;
}
