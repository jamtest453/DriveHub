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


def test_provider_links_respect_user_choice_to_include_unknown_colour():
    from urllib.parse import parse_qs, urlsplit
    from src.query_builder import generate_links
    base={"colours":["blue","grey"],"includeUnknownColours":True}
    wide=validate_filters(base)
    links={link["site"]:link for link in generate_links(wide,search_name="BMW M2")}
    auto=parse_qs(urlsplit(links["autotrader"]["url"]).query)
    assert "colour" not in auto, "Provider colour facets would exclude missing exterior paint"
    assert auto["make"] == ["BMW"]
    assert auto["model"] == ["M2"]
    assert auto.get("exclude-writeoff-categories") == ["on"]
    assert "colour" not in parse_qs(urlsplit(links["facebook"]["url"]).query)
    assert "apiColourFilter" not in links["ebay"]
    for link in links.values():
        assert "unknown" in link["sourceNote"].casefold()
    # Strict mode can use a supported provider colour facet, without
    # accidentally turning multiple paint choices into one string.
    narrow=validate_filters({"colours":["blue","grey"],"includeUnknownColours":False})
    strict={link["site"]:link for link in generate_links(narrow,search_name="BMW M2")}
    auto=parse_qs(urlsplit(strict["autotrader"]["url"]).query)
    assert auto["colour"] == ["Blue","Grey"]
    assert "colour" not in parse_qs(urlsplit(strict["facebook"]["url"]).query)
    # PistonHeads facet encodings differ; never invent source-side params.
    assert "price=" not in strict["pistonheads"]["url"]
    # Known incorrect paint is removed while unknown paint is retained.
    assert apply_local_filters({"title":"BMW M2 Alpine White"},wide,"BMW M2")[0] is False
    assert apply_local_filters({"title":"BMW M2"},wide,"BMW M2")[0] is True


def test_existing_search_results_update_without_rescan(tmp_path):
    source=Path(__file__).resolve().parents[1]/"public/dashboard.js"
    cases=r"""
let revision=0, derivedRevision=null;
const derivedVisibleIds=new Map(),derivedSearchGroups=new Map();
function resetDerivedCache(){
 if(derivedRevision===revision)return;
 derivedRevision=revision;
 derivedVisibleIds.clear();derivedSearchGroups.clear();
}
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
search.filters.colours=['red']; revision++;
check('edit to red immediately applies to old snapshots',ids(),'C');
search.filters.colours=['blue']; revision++;
search.filters.includeUnknownColours=true; revision++;
check('explicitly include unknown colour',ids(),'A,B,D');
search.filters.colours=[]; revision++;
check('all colours unrestricted',ids(),'A,B,C,D');
search.filters.colours=['grey']; revision++;
search.filters.includeUnknownColours=false; revision++;
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


def test_colour_unknown_option_defaults_on_and_remains_editable():
    root=Path(__file__).resolve().parents[1]
    html=(root/"public/dashboard.html").read_text()
    js=(root/"public/dashboard.js").read_text()
    assert "Also include cars whose exterior colour is unknown" in html
    assert "includeUnknownColours:$('carStrictColour').checked" in js
    assert 'id="carStrictColour" checked' in html
    assert "found?.filters?.includeUnknownColours ?? true" in js
    assert "function matchingSearchIds(search)" in js
