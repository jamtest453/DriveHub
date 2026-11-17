"""Run the real client-side search-local hidden rules in Node."""
import subprocess
from pathlib import Path


def test_hidden_cars_are_scoped_to_each_saved_search(tmp_path):
    source=Path(__file__).resolve().parents[1]/"public/dashboard.js"
    cases=r"""
const state={
  searches:[{id:'s1'},{id:'s2'}],
  hiddenBySearch:{s1:['a'],s2:[]},
  listings:{
    a:{id:'a',model:'one',title:'BMW M2',saved:true},
    b:{id:'b',model:'one',title:'BMW M2',saved:false},
    c:{id:'c',model:'two',title:'BMW M4'},
    d:{id:'d',model:'one',title:'BMW M2'}
  }
};
let revision=0, derivedRevision=null;
const derivedVisibleIds=new Map(),derivedSearchGroups=new Map();
function resetDerivedCache(){
 if(derivedRevision===revision)return;
 derivedRevision=revision;
 derivedVisibleIds.clear();derivedSearchGroups.clear();
}
const available={
  s1:['a','b','c','d'],
  s2:['a','b','c']
};
const matchingSearchIds=search=>available[search.id];
const grouped=items=>{
 const map=new Map();
 for(const item of items){
   if(!map.has(item.model))map.set(item.model,[]);
   map.get(item.model).push(item);
 }
 return [...map.values()];
};
const eq=(name,a,b)=>{
 if(JSON.stringify(a)!==JSON.stringify(b))
   throw Error(name+': '+JSON.stringify(a)+' != '+JSON.stringify(b));
};
eq('first search hides entire matching group',visibleSearchIds(state.searches[0]),['c']);
eq('other search stays untouched',visibleSearchIds(state.searches[1]),['a','b','c']);
eq('new matching advert hidden only in first search',
   hiddenSearchGroups(state.searches[0])[0].map(x=>x.id),['a','b','d']);
eq('other search has no hidden section',hiddenSearchGroups(state.searches[1]),[]);
eq('overview keeps car visible through second search',currentIds(),['c','a','b']);
eq('saved record is unchanged',state.listings.a.saved,true);
state.hiddenBySearch.s1=[];
revision++;
eq('restoring first search reveals all adverts',
   visibleSearchIds(state.searches[0]),['a','b','c','d']);
console.log('Per-search hidden grouping passed');
"""
    script=tmp_path/"rules.js";script.write_text(cases)
    runner=r"""
const fs=require('fs'),vm=require('vm');
const code=fs.readFileSync(process.argv[1],'utf8');
const cases=fs.readFileSync(process.argv[2],'utf8');
const a=code.indexOf('function searchHiddenIds(');
const b=code.indexOf('function getSearch()',a);
if(a<0||b<a)throw Error('Could not locate real visibility functions');
vm.runInNewContext(cases.replace('eq(',code.slice(a,b)+'\neq('),
  {console,Set,Map});
"""
    # Insert functions just before first assertion; they must be the app's
    # production functions rather than test replicas.
    result=subprocess.run(["node","-e",runner,str(source),str(script)],
                          capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr
    assert "Per-search hidden grouping passed" in result.stdout


def test_collapsible_ui_is_per_search_and_below_main_results():
    root=Path(__file__).resolve().parents[1]
    html=(root/"public/dashboard.html").read_text()
    js=(root/"public/dashboard.js").read_text()
    assert html.index('id="hiddenResultsPanel"') > html.index('id="listingMapPanel"')
    assert html.index('id="hiddenResultsPanel"') > html.index('id="listingGrid"')
    assert '<details id="hiddenResultsPanel"' in html
    assert "panel.open=false" in js
    assert "data-view=\"hidden\"" not in js
    assert "hiddenSearchGroups(search)" in js
    assert "hiddenBySearch" in js
    assert "body:JSON.stringify({searchId,ids,hidden})" in js
