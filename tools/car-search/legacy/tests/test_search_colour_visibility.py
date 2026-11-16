"""Saved-search colour choices must filter existing cross-site results immediately."""
from pathlib import Path
import subprocess

from src.query_builder import apply_local_filters, validate_filters


def test_search_requires_confirmed_colour_by_default():
    selected = validate_filters({"colours":["blue"]})
    assert selected["includeUnknownColours"] is False
    assert selected["strictColour"] is True
    assert apply_local_filters({"title":"BMW M2 Coupe"},selected,"BMW M2")[0] is False
    assert apply_local_filters({"title":"BMW M2 Long Beach Blue"},selected,"BMW M2")[0] is True
    assert apply_local_filters({"title":"BMW M2 Mineral Grey"},selected,"BMW M2")[0] is False
    broad = validate_filters({"colours":["blue"],"includeUnknownColours":True})
    assert apply_local_filters({"title":"BMW M2 Coupe"},broad,"BMW M2")[0] is True
    assert apply_local_filters({"title":"BMW M2 Mineral Grey"},broad,"BMW M2")[0] is False


def test_existing_search_results_update_without_rescan(tmp_path):
    source=Path(__file__).resolve().parents[1]/"public/dashboard.js"
    cases=r"""
const state = {
  listings:{
    A:{id:'A',site:'autotrader',group:'one',colour:'blue',colourSource:'explicit'},
    B:{id:'B',site:'facebook',group:'one',title:'BMW M2',colourSource:'unknown'},
    C:{id:'C',site:'ebay',group:'two',colour:'red',colourSource:'explicit'},
    D:{id:'D',site:'pistonheads',group:'three',title:'BMW M2',colourSource:'unknown'}
  },
  snapshots:{source1:{ids:['A','B','C','D']}},
  searches:[{id:'s1',links:[{id:'source1'}],
    filters:{colours:['blue'],includeUnknownColours:false}}]
};
function grouped(items) {
  const groups=new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group,[]);
    groups.get(item.group).push(item);
  }
  return [...groups.values()];
}
const search=state.searches[0];
const ids=()=>matchingSearchIds(search).sort().join(',');
const check=(label,actual,expected)=>{
  if(actual!==expected) throw Error(label+': expected '+expected+' got '+actual);
};
check('blue search includes missing-colour same-car source',ids(),'A,B');
check('overview uses matching results',currentIds().sort().join(','),'A,B');
search.filters.colours=['red'];
check('edit to red immediately applies to old snapshots',ids(),'C');
search.filters.colours=['blue'];
search.filters.includeUnknownColours=true;
check('explicitly include unknown colour',ids(),'A,B,D');
search.filters.colours=[];
check('all colours unrestricted',ids(),'A,B,C,D');
search.filters.colours=['grey'];
search.filters.includeUnknownColours=false;
check('no wrong colour slips through',ids(),'');
console.log('Saved search colour snapshot checks passed');
"""
    cases_file=tmp_path/"cases.js"
    cases_file.write_text(cases)
    runner=r"""
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
function section(start,end) {
 const a=source.indexOf(start),b=source.indexOf(end,a);
 if(a<0 || b<0)throw Error('Missing code section '+start);
 return source.slice(a,b);
}
const choices=section('const COLOUR_CHOICES =','let scanBusy');
const colour=section('function exteriorColour(','function matchesResultFilters(');
const search=section('function availableIds(','function getSearch(');
const cases=fs.readFileSync(process.argv[2],'utf8');
vm.runInNewContext(choices+'\n'+colour+'\n'+search+'\n'+cases,{console,Map,Set});
"""
    result=subprocess.run(["node","-e",runner,str(source),str(cases_file)],
                          capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr
    assert "Saved search colour snapshot checks passed" in result.stdout


def test_colour_unknown_option_is_unambiguously_opt_in():
    root=Path(__file__).resolve().parents[1]
    html=(root/"public/dashboard.html").read_text()
    js=(root/"public/dashboard.js").read_text()
    assert "Also include cars whose exterior colour is unknown" in html
    assert "includeUnknownColours:$('carStrictColour').checked" in js
    assert "found?.filters?.includeUnknownColours === true" in js
    assert "function matchingSearchIds(search)" in js
