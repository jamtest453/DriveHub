"""Actual JS regressions: combined multi-site specifications and distance sort."""
import subprocess
from pathlib import Path


JS = Path(__file__).resolve().parents[1] / "public/dashboard.js"


def run_js(js, tmp_path, suite):
    script=tmp_path/"assertions.js"
    script.write_text(suite)
    runner=r"""
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const assertions=fs.readFileSync(process.argv[2],'utf8');
const between=(a,b)=>{
 const start=source.indexOf(a),end=source.indexOf(b,start+1);
 if(start<0||end<0)throw Error('Missing source section '+a);
 return source.slice(start,end);
};
const merge=between('function combinedCarDetails(','function matchesResultFilters(');
const detail=between('function combinedDetailFieldsMarkup(','function renderCarDetails()');
const stubs=[
 "const SITE_NAMES={autotrader:'Auto Trader',facebook:'Facebook',ebay:'eBay'};",
 "const imageUrl=x=>String(x||'').startsWith('https://')?x:'';",
 "const exteriorColour=x=>['explicit','title'].includes(x.colourSource)?x.colour||'':'';",
 "const vehicleMileage=x=>x.mileage==null?null:Number(x.mileage);",
 "const effectiveTransmission=x=>x.transmission||'';",
 "const locationForCar=x=>x.location||'';",
 "const linkUrl=x=>String(x||'');",
 "const esc=x=>String(x??'').replace(/&/g,'&amp;');"
].join('\n');
vm.runInNewContext(stubs+'\n'+merge+'\n'+detail+'\n'+assertions,
  {console,Intl,Number,Math});
"""
    result=subprocess.run(["node","-e",runner,str(js),str(script)],
                          capture_output=True,text=True,timeout=20)
    assert result.returncode==0,result.stderr
    return result.stdout


def test_complementary_details_and_conflicts(tmp_path):
    suite=r"""
const rows=[
 {id:'AT1',site:'autotrader',title:'2017 BMW M2 Coupe',year:2017,
  price:24500,mileage:52400,colour:'blue',colourSource:'explicit',
  location:'Hayes (157 miles)',description:'One owner',notes:'secret'},
 {id:'FB2',site:'facebook',title:'BMW M2 DCT Coupe',price:23800,
  transmission:'automatic',bhp:365,mileage:52470,location:'Hayes',
  image:'https://example.com/car.jpg',description:'Heated seats'},
 {id:'EB3',site:'ebay',title:'BMW M2 2017',engine:3.0,
  registration:'AB17 CDE',price:23999,description:'Full service history'}
];
const prior=JSON.stringify(rows),merged=combinedCarDetails(rows,rows[0]);
const eq=(label,a,b)=>{if(a!==b)throw Error(label+': '+a+' != '+b)};
eq('lowest price',merged.price,23800);
eq('year',merged.year,2017);
eq('mileage',merged.mileage,52470);
eq('mile range',merged.combinedMeta.fields.mileage.display,'52,400–52,470 miles');
eq('colour',merged.colour,'blue');
eq('transmission',merged.transmission,'automatic');
eq('engine',merged.engine,3);
eq('power',merged.bhp,365);
eq('registration',merged.registration,'AB17 CDE');
eq('image',merged.image,'https://example.com/car.jpg');
eq('sources',merged.combinedMeta.sources.length,3);
eq('untouched providers',JSON.stringify(rows),prior);
const conflict=combinedCarDetails([
 {...rows[0],mileage:20000,colour:'blue'},
 {...rows[1],mileage:70000,colour:'red',colourSource:'explicit'}
]);
eq('different mileages unknown',conflict.mileage,null);
eq('mileage conflict marked',conflict.combinedMeta.fields.mileage.conflict,true);
eq('conflicting colour unknown',conflict.colour,null);
eq('colour conflict marked',conflict.combinedMeta.fields.colour.conflict,true);
const html=combinedDetailFieldsMarkup(conflict);
if(!html.includes('20,000 miles')||!html.includes('70,000 miles'))
  throw Error('Per-provider mileage missing');
const notes=combinedDescriptionsMarkup(rows);
if(!notes.includes('Heated seats')||!notes.includes('Full service history')||
   notes.includes('secret'))throw Error('Bad descriptions');
console.log('Combined detail cases passed');
"""
    assert 'Combined detail cases passed' in run_js(JS,tmp_path,suite)


def test_distance_sort_when_coordinates_missing(tmp_path):
    source=JS.read_text()
    a=source.index('function renderResults() {')
    b=source.index('function mapLocationForGroup(',a)
    assert a>=0 and b>a
    code=source[a:b]
    # Execute the actual sorter in its render wrapper, with thin UI stubs.
    suite=r"""
const rows=[
 {id:'near',price:23000,miles:15,firstSeen:'2026-11-12T00:00:00Z'},
 {id:'far',price:22000,miles:145,firstSeen:'2026-11-12T00:00:00Z'},
 {id:'unknown',price:21000,miles:null,firstSeen:'2026-11-12T00:00:00Z'}
];
const controls={};
function $(name){
 if(!controls[name])controls[name]={value:'',checked:false,innerHTML:'',
  classList:{toggle(){}},setAttribute(){},querySelectorAll(){return []}};
 return controls[name];
}
$('sourceFilter').value='all';
$('sortFilter').value='distanceNear';
const getSearch=()=>null,relevantListings=()=>rows;
const wantsDistanceCoordinates=()=>['distanceNear','distanceFar'].includes($('sortFilter').value);
let resolutions=0;
const ensureDistanceLocations=()=>{resolutions++};
const statusSets=()=>({newIds:new Set(),changedIds:new Set()});
const grouped=x=>x.map(row=>[row]);
const baseGroupsForView=grouped;
const matchesResultFilters=()=>true;
const groupMatchesColour=()=>true,groupMatchesDistance=()=>true;
const combinedCarDetails=g=>g[0];
const milesForGroup=g=>g[0].miles;
const renderCard=g=>g[0].id+',';
const renderHiddenResults=()=>{};
const state={searches:[{id:'s1'}]};
const resultsLayout='list',view='overview',scanBusy=false,mergeFrom=null;
const distanceLookupBusy=false;
renderResults();
const eq=(label,actual,want)=>{
 if(actual!==want)throw Error(label+': '+actual+' != '+want);
};
eq('near first',$('listingGrid').innerHTML,'near,far,unknown,');
eq('trigger location resolution',resolutions,1);
$('sortFilter').value='distanceFar';
renderResults();
eq('far first',$('listingGrid').innerHTML,'far,near,unknown,');
$('sortFilter').value='priceLow';
renderResults();
eq('price sorting unaffected',$('listingGrid').innerHTML,'unknown,far,near,');
console.log('Distance sort cases passed');
"""
    runner=r"""
const fs=require('fs'),vm=require('vm');
const code=fs.readFileSync(process.argv[1],'utf8');
const test=fs.readFileSync(process.argv[2],'utf8');
vm.runInNewContext(test.replace('renderResults();',
  code+'\nrenderResults();'),{console,Set,Date,Number,Math});
"""
    p=tmp_path/"distance.js";p.write_text(suite)
    snippet=tmp_path/"sorter.js";snippet.write_text(code)
    result=subprocess.run(["node","-e",runner,str(snippet),str(p)],
                          capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr
    assert "Distance sort cases passed" in result.stdout


def test_ui_elements_exist():
    root=JS.parent
    html=(root/"dashboard.html").read_text()
    css=(root/"styles.css").read_text()
    js=JS.read_text()
    assert 'value="distanceNear"' in html
    assert 'value="distanceFar"' in html
    assert "combinedDetailFieldsMarkup(combined)" in js
    assert "combinedDescriptionsMarkup(variants)" in js
    assert "wantsDistanceCoordinates()" in js
    assert ".combined-details" in css
