import sharp from 'sharp';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mesh} from 'topojson-client';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sources=[
 ['surface','nasa-blue-marble-200407-5400.jpg','https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography/july/world.topo.200407.3x5400x2700.jpg','NASA Earth Observatory / Reto Stöckli; MODIS, July 2004'],
 ['height','nasa-topography-5400.jpg','https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/topography/gebco_08_rev_elev_5400x2700.jpg','NASA Earth Observatory / Jesse Allen, GEBCO; grayscale 0–6400 m'],
 ['clouds','nasa-clouds-2048.jpg','https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg','NASA Goddard / Reto Stöckli; Blue Marble cloud composite, published 2002']
];
const provenance={acquired:'2026-10-06',generated:'2026-10-07',projection:'Equirectangular; left -180°, right +180°, top +90°, bottom -90°. No crop, flip, longitude shift or recoloring.',license:'NASA Images and Media Usage Guidelines; acknowledge NASA, no endorsement implied. GEBCO attribution retained.',policy:'https://www.nasa.gov/nasa-brand-center/images-and-media/',sources:[],outputs:[]};
await mkdir('assets/realistic',{recursive:true});
for(const [kind,name,url,credit]of sources){
 const input=await readFile('assets/upstream/'+name),meta=await sharp(input).metadata();
 provenance.sources.push({kind,file:'assets/upstream/'+name,url,credit,width:meta.width,height:meta.height,sha256:hash(input)});
 for(const [tier,width]of kind==='clouds'?[['low',1024],['standard',2048]]:[['low',1024],['standard',2048],['high',4096]]){
  const file='assets/realistic/'+kind+(kind==='clouds'?'-hd-':'-')+tier+(kind==='surface'?'.jpg':'.png');
  let pipeline=sharp(input).resize(width,width/2,{fit:'fill',kernel:'lanczos3'});
  // Height and cloud alpha are linear data, not sRGB color textures.
  if(kind!=='surface')pipeline=pipeline.greyscale();
  if(kind==='clouds')pipeline=pipeline.toColourspace('b-w');
  const output=await(kind==='surface'?pipeline.jpeg({quality:94,chromaSubsampling:'4:4:4'}):pipeline.png()).toBuffer();
  await writeFile(file,output);provenance.outputs.push({file,width,height:width/2,bytes:output.length,sha256:hash(output)});
 }
}
const cloudFile='assets/upstream/nasa-clouds-8192.tif',cloudInput=await readFile(cloudFile),cloudMeta=await sharp(cloudInput).metadata();
if(cloudMeta.width!==8192||cloudMeta.height!==4096)throw Error('NASA 高清云图尺寸不符');
provenance.sources.push({kind:'clouds-hd',acquired:'2026-10-07',file:cloudFile,url:'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif',credit:'NASA Goddard / Reto Stöckli; Blue Marble cloud composite, published 2002',width:8192,height:4096,sha256:hash(cloudInput)});
for(const [tier,width]of [['high',4096],['8k',8192]]){
 const file='assets/realistic/clouds-hd-'+tier+'.png';
 const output=await sharp(cloudInput).resize(width,width/2,{fit:'fill',kernel:'lanczos3'}).greyscale().toColourspace('b-w').png().toBuffer();
 await writeFile(file,output);provenance.outputs.push({file,width,height:width/2,bytes:output.length,sha256:hash(output)});
}
const hiresFile='assets/upstream/nasa-blue-marble-200407-21600.jpg',hires=await readFile(hiresFile);
provenance.sources.push({kind:'surface-8k',file:hiresFile,url:'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography/july/world.topo.200407.3x21600x10800.jpg',credit:'NASA Earth Observatory / Reto Stöckli; MODIS, July 2004',width:21600,height:10800,sha256:hash(hires)});
const hiresOutput=await sharp(hires).resize(8192,4096,{fit:'fill',kernel:'lanczos3'}).jpeg({quality:94,chromaSubsampling:'4:4:4'}).toBuffer(),hiresPath='assets/realistic/surface-8k.jpg';
await writeFile(hiresPath,hiresOutput);provenance.outputs.push({file:hiresPath,width:8192,height:4096,bytes:hiresOutput.length,sha256:hash(hiresOutput)});
const atlas=JSON.parse(await readFile('node_modules/world-atlas/countries-110m.json','utf8'));
const borders=mesh(atlas,atlas.objects.countries,(a,b)=>a!==b).coordinates;
const file='assets/realistic/borders.json',data=Buffer.from(JSON.stringify(borders));await writeFile(file,data);
provenance.borders={file,source:'world-atlas 2.0.2 / Natural Earth 110m',license:'Natural Earth public domain; world-atlas ISC',sha256:hash(data),note:'Illustrative internal country boundaries; does not determine record region or settle disputed borders.'};
await writeFile('assets/realistic/provenance.json',JSON.stringify(provenance,null,2)+'\n');
console.log(provenance.outputs.map(o=>o.file+' '+o.bytes).join('\n'));
