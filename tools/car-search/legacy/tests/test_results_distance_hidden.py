"""Regressions for colour, distance, hidden cars and link handling."""
import json
import subprocess
from pathlib import Path

import httpx
import pytest
import server
from src.location_map import clean_location, place_request


@pytest.mark.asyncio
async def test_hidden_is_per_search_and_preserves_favourites_and_notes(monkeypatch,tmp_path):
    monkeypatch.setattr(server,"PASSWORD","")
    monkeypatch.setattr(server,"DATA_DIR",tmp_path)
    monkeypatch.setattr(server,"DATA_FILE",tmp_path/"cars.json")
    car={"id":"autotrader:1","site":"autotrader","title":"BMW M2",
         "saved":True,"price":23000,"notes":"Keep this note",
         "priceHistory":[{"price":23000,"at":"2026-11-15"}]}
    second={"id":"facebook:2","site":"facebook","title":"BMW M2","saved":False}
    searches=[
        {"id":"s1","name":"M2","links":[{"id":"url1"}]},
        {"id":"s2","name":"BMW","links":[{"id":"url2"}]},
    ]
    monkeypatch.setattr(server,"state",{**server.fresh_state(),
       "searches":searches,
       "listings":{"autotrader:1":car,"facebook:2":second},
       "snapshots":{
           "url1":{"ids":["autotrader:1","facebook:2"]},
           "url2":{"ids":["autotrader:1","facebook:2"]},
       }})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        response=await client.post("/api/listings/hidden",json={
           "searchId":"s1","ids":["autotrader:1","facebook:2"],"hidden":True})
        assert response.status_code==200,response.text
        model=response.json()["state"]
        assert model["hiddenBySearch"]["s1"]==["autotrader:1","facebook:2"]
        assert model["hiddenBySearch"].get("s2",[])==[]
        assert car["saved"] and car["notes"]=="Keep this note"
        assert len(car["priceHistory"])==1
        assert (tmp_path/"cars.json").is_file()

        # Hiding the same listing in the second search is independent.
        response=await client.post("/api/listings/hidden",json={
           "searchId":"s2","ids":["autotrader:1"],"hidden":True})
        assert response.status_code==200,response.text
        response=await client.post("/api/listings/hidden",json={
           "searchId":"s1","ids":["autotrader:1","facebook:2"],"hidden":False})
        assert response.status_code==200,response.text
        model=response.json()["state"]
        assert model["hiddenBySearch"]["s1"]==[]
        assert model["hiddenBySearch"]["s2"]==["autotrader:1"]
        assert not car.get("hidden")
        response=await client.post("/api/listings/hidden",json={
           "searchId":"s1","ids":["autotrader:1","missing"],"hidden":True})
        assert response.status_code==404
        response=await client.post("/api/listings/hidden",json={
           "searchId":"s1","ids":["autotrader:1"],"hidden":"yes"})
        assert response.status_code==400
        response=await client.post("/api/listings/hidden",json={
           "searchId":"nonexistent","ids":["autotrader:1"],"hidden":True})
        assert response.status_code==404


def test_legacy_global_hidden_migrates_into_each_search(monkeypatch,tmp_path):
    data=server.fresh_state()
    data.update({
        "searches":[{"id":"s1","links":[{"id":"one"}]},
                    {"id":"s2","links":[{"id":"two"}]}],
        "snapshots":{"one":{"ids":["a","b"]},"two":{"ids":["b","c"]}},
        "listings":{
            "a":{"id":"a","title":"BMW M2","hidden":True,"saved":True,
                 "notes":"Keep this note"},
            "b":{"id":"b","title":"BMW M2","hidden":True},
            "c":{"id":"c","title":"BMW M3","hidden":False}
        }
    })
    path=tmp_path/"old.json";path.write_text(json.dumps(data))
    monkeypatch.setattr(server,"DATA_FILE",path)
    restored=server.load_state()
    assert restored["hiddenBySearch"]=={"s1":["a","b"],"s2":["b"]}
    assert restored["hiddenPerSearchMigrated"] is True
    assert restored["listings"]["a"]["saved"] is True
    assert restored["listings"]["a"]["notes"]=="Keep this note"

def test_old_colour_guesses_are_classified_from_safe_title_only(monkeypatch,tmp_path):
    data=server.fresh_state()
    data["listings"]={
        "a":{"id":"a","title":"2017 BMW M2 Long Beach Blue",
             "colour":"black","saved":True,"notes":"important"},
        "b":{"id":"b","title":"2017 BMW M2","colour":"black"},
        "c":{"id":"c","title":"2017 BMW M2 Mineral Grey",
             "colour":"grey","colourSource":"explicit"}
    }
    path=tmp_path/"cars.json";path.write_text(json.dumps(data))
    monkeypatch.setattr(server,"DATA_FILE",path)
    restored=server.load_state()["listings"]
    assert restored["a"]["colour"]=="blue" and restored["a"]["colourSource"]=="title"
    assert restored["a"]["notes"]=="important"
    assert restored["b"].get("colour") is None
    assert restored["b"]["colourSource"]=="unknown"
    assert restored["c"]["colourSource"]=="explicit"


@pytest.mark.parametrize("raw,clean",[
    ("Sutton Coldfield · 28 miles away","Sutton Coldfield"),
    ("Milton Keynes - 120 miles away","Milton Keynes"),
    ("Stoke-on-Trent (46 miles)","Stoke-on-Trent"),
    ("Birmingham, England, United Kingdom","Birmingham"),
    ("Nelson, Lancashire","Nelson, Lancashire"),
])
def test_location_normalisation(raw,clean):
    assert clean_location(raw)==clean
    assert place_request(raw) is not None


def test_actual_js_group_colour_and_distance_results_filter(tmp_path):
    root=Path(__file__).resolve().parents[1]
    source=root/"public/dashboard.js"
    cases=r"""
const blue={colour:'blue',colourSource:'explicit',location:'Near Town'};
const unknown={title:'BMW M2',location:'Far Town'};
const grey={colour:'grey',colourSource:'title'};
const check=(label,got,want)=>{if(got!==want)throw Error(label+' expected '+want+' got '+got)};
fields.resultColour.value='unknown';
check('unknown advert within known blue group is not unknown',
      groupMatchesColour([blue,unknown]),false);
check('whole group without paint is unknown',groupMatchesColour([unknown]),true);
fields.resultColour.value='blue';
check('blue car matched even if another site omitted colour',
      groupMatchesColour([unknown,blue]),true);
check('grey car excluded from blue',groupMatchesColour([grey,unknown]),false);
fields.resultDistanceMax.value='10';
locationPoints.set('near town',{lat:53.40,lng:-2.08});
locationPoints.set('far town',{lat:51.50,lng:-0.12});
check('near High Lane',groupMatchesDistance([{location:'Near Town'}]),true);
check('far from High Lane',groupMatchesDistance([{location:'Far Town'}]),false);
check('unknown location kept by default with distance constraint',
      groupMatchesDistance([{location:'Unknown'}]),true);
fields.resultHideUnknown.checked=true;
check('unknown location excluded when hiding unstated details',
      groupMatchesDistance([{location:'Unknown'}]),false);
check('far car still excluded when hiding unstated details',
      groupMatchesDistance([{location:'Far Town'}]),false);
check('use location from another provider in grouped car',
      groupMatchesDistance([{location:'Unknown'},{location:'Near Town'}]),true);
fields.resultDistanceMax.value='';
check('clear distance includes unknown',
      groupMatchesDistance([{location:'Unknown'}]),true);
console.log('Colour and distance checks passed');
"""
    cases_file=tmp_path/"cases.js"
    cases_file.write_text(cases)
    runner=r"""
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const cases=fs.readFileSync(process.argv[2],'utf8');
function section(start,end) {
 const a=source.indexOf(start),b=source.indexOf(end,a);
 if(a<0 || b<0)throw Error('Missing '+start);
 return source.slice(a,b);
}
const colours=section('const COLOUR_CHOICES =','let scanBusy');
const colour=section('function exteriorColour(', 'function matchesResultFilters(');
const groups=section('function groupMatchesColour(', 'function renderResults(');
const fields={resultColour:{value:'any'},resultDistanceMax:{value:''},resultHideUnknown:{checked:false}};
const ctx={console,Math,Number,locationPoints:new Map(),
  DISTANCE_ORIGIN:{lat:53.36397,lng:-2.06781},
  mapLocationKey:loc=>String(loc).trim().toLowerCase(),
  $:id=>fields[id],fields};
vm.runInNewContext(colours+'\n'+colour+'\n'+groups+'\n'+cases,ctx);
"""
    response=subprocess.run(["node","-e",runner,str(source),str(cases_file)],
        capture_output=True,text=True,timeout=15)
    assert response.returncode==0,response.stderr
    assert "Colour and distance checks passed" in response.stdout


def test_right_click_and_hidden_controls_are_wired():
    root=Path(__file__).resolve().parents[1]
    code=(root/"public/dashboard.js").read_text()
    html=(root/"public/dashboard.html").read_text()
    assert "document.addEventListener('contextmenu'" in code
    assert "window.open(url,'_blank','noopener,noreferrer')" in code
    assert 'data-action="hide-listing"' in code
    assert 'id="hiddenResultsPanel"' in html
    assert 'id="hiddenListingGrid"' in html
    assert 'data-view="hidden"' not in code
    assert "hiddenSearchGroups(search)" in code
    assert "renderHiddenResults(search,statuses)" in code
    assert "visibleSearchIds(search)" in code
    assert "api('/api/listings/hidden'" in code
    assert 'id="resultDistanceMax"' in html
    assert "High Lane" in html
