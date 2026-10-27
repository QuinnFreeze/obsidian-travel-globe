export const MIN_ALTITUDE=.00025;
export const MAX_ALTITUDE=5.5;
export const MERCATOR_LIMIT=85.0511287798066;
export const clampAltitude=(value:number)=>Math.max(MIN_ALTITUDE,Math.min(MAX_ALTITUDE,value));
/** Scale height above the surface, rather than distance from Earth's centre. */
export function zoomAltitude(altitude:number,delta:number){return clampAltitude(altitude*Math.exp(Math.max(-.7,Math.min(.7,delta))));}
export function mercatorY(lat:number){const radians=Math.max(-MERCATOR_LIMIT,Math.min(MERCATOR_LIMIT,lat))*Math.PI/180;return (1-Math.asinh(Math.tan(radians))/Math.PI)/2;}
export function tileLatitude(y:number,z:number){return Math.atan(Math.sinh(Math.PI*(1-2*y/2**z)))*180/Math.PI;}
export function tileLongitude(x:number,z:number){return x/2**z*360-180;}
export interface ImageryTile {z:number;x:number;y:number;key:string}
/** Screen rays supply the actual visible footprint, including the date-line wrap. */
export function visibleTiles(samples:{lat:number;lng:number}[],center:{lat:number;lng:number},altitude:number,height:number,fov:number,budget:number){
  if(!samples.length||altitude>=.95||Math.abs(center.lat)>MERCATOR_LIMIT)return [];
  const metresPerPixel=altitude*6371000*2*Math.tan(fov*Math.PI/360)/Math.max(1,height);
  let z=Math.max(2,Math.min(14,Math.floor(Math.log2(40075016.686*Math.cos(center.lat*Math.PI/180)/(256*metresPerPixel)))));
  const xs=samples.map(p=>(center.lng+((p.lng-center.lng+540)%360)-180+180)/360),ys=samples.map(p=>mercatorY(p.lat));
  let result:ImageryTile[]=[];
  do{
    const n=2**z,x0=Math.floor(Math.min(...xs)*n),x1=Math.floor(Math.max(...xs)*n),y0=Math.max(0,Math.floor(Math.min(...ys)*n)),y1=Math.min(n-1,Math.floor(Math.max(...ys)*n));
    result=[];
    if((x1-x0+1)*(y1-y0+1)<=budget)for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const wrapped=((x%n)+n)%n;result.push({z,x:wrapped,y,key:`${z}/${wrapped}/${y}`});
    }
    if(result.length)break;
  }while(--z>=0);
  const n=2**(result[0]?.z??0),cx=(center.lng+180)/360*n,cy=mercatorY(center.lat)*n;
  return result.sort((a,b)=>{const distance=(t:ImageryTile)=>Math.min(Math.abs(t.x+.5-cx),n-Math.abs(t.x+.5-cx))**2+(t.y+.5-cy)**2;return distance(a)-distance(b);});
}
