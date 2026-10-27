export interface City {id:string;city:string;country_code:string;country_name:string;admin:string;latitude:number;longitude:number;aliases:string}
type CityRows=(string|number)[][];
const display=new Intl.DisplayNames(['zh-CN'],{type:'region'});
const countries=new Map<string,string>();
export function countryName(code:string):string {let name=countries.get(code);if(!name){try{name=display.of(code)||code;}catch{name=code;}countries.set(code,name);}return name;}
let loader:(()=>Promise<CityRows>)|undefined;
let catalog:Promise<City[]>|undefined;
export function configureCityLoader(load:()=>Promise<CityRows>){loader=load;catalog=undefined;}
export async function cityCatalog():Promise<City[]> {
  if(!catalog){
    if(!loader)throw Error('城市目录尚未初始化。');
    const work=loader().then(rows=>rows.map(r=>({id:'geonames:'+r[0],city:String(r[1]),country_code:String(r[2]),
      country_name:countryName(String(r[2])),admin:String(r[3]),latitude:Number(r[4]),longitude:Number(r[5]),aliases:String(r[6]).toLowerCase()})));
    catalog=work;void work.catch(()=>{if(catalog===work)catalog=undefined;});
  }
  return catalog;
}
export async function searchCities(query:string,code=''):Promise<{results:City[];total:number}> {
  const q=query.trim().normalize('NFKC').toLowerCase();
  if(q.length<2)return {results:[],total:0};
  const exact:City[]=[],partial:City[]=[];let total=0;
  for(const city of await cityCatalog()){
    if(code&&city.country_code!==code)continue;
    const name=city.city.toLowerCase();if(!name.includes(q)&&!city.aliases.includes(q))continue;
    total++;
    // Delimiter matching avoids allocating alias arrays or sorting every broad query.
    const list=name===q||('|'+city.aliases+'|').includes('|'+q+'|')?exact:partial;
    if(list.length<30)list.push(city);
  }
  return {results:[...exact,...partial].slice(0,30),total};
}
