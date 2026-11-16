"""Deduplication tests executing the actual dashboard JavaScript via Node."""
import subprocess
from pathlib import Path

import httpx
import pytest

import server


def test_duplicate_matching_on_real_dashboard_javascript():
    source = Path(__file__).resolve().parents[1] / "public/dashboard.js"
    script = r"""
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const matching=source.slice(source.indexOf('function manualRoot('),
                            source.indexOf('function statusSets()'));
const transmission=source.slice(source.indexOf('function effectiveTransmission('),
                                source.indexOf('function exteriorColour('));
const colour=source.slice(source.indexOf('function exteriorColour('),
                          source.indexOf('function matchesResultFilters('));
const suite=fs.readFileSync(process.argv[2],'utf8');
const coloursAt=source.indexOf('const COLOUR_CHOICES = ');
const colours=source.slice(coloursAt,source.indexOf(';',coloursAt)+1);
vm.runInNewContext(colours + '\nconst state={manualDuplicates:{},separateDuplicates:{}};\n' +
  matching + '\n' + transmission + '\n' + colour + '\n' + suite,{console});
"""
    suite = r"""
const car=(id,site,overrides={})=>({
  id,site,title:'2017 BMW M2 Coupe',price:23500,year:2017,
  mileage:null,location:'',transmission:'',colour:'',
  saved:false,image:'',...overrides
});
const paint=(o)=>({...o,colourSource:'explicit'});
const a=car('autotrader:1','autotrader');
const b=car('pistonheads:2','pistonheads');
function check(name,result,want) {
  if (result!==want) throw new Error(name+': expected '+want+' got '+result);
}
// Generic model titles and identical prices must NOT automatically merge.
check('price and generic matching title alone are insufficient',duplicate(a,b),false);
check('same brand but M4 is not M2',
      duplicate(a,car('facebook:3','facebook',{title:'2017 BMW M4 Coupe'})),false);
check('different model 3 Series',
      duplicate(a,car('facebook:4','facebook',{title:'2017 BMW 330i Coupe'})),false);
check('same site is never automatically grouped',
      duplicate(a,car('autotrader:5','autotrader')),false);
const tripleA=paint(car('autotrader:100','autotrader',{
  title:'2017 BMW M2 Coupe',colour:'blue',location:'Milton Keynes (120 miles)',
  mileage:52350,price:23500
}));
const tripleB=paint(car('facebook:101','facebook',{
  title:'BMW M2 3.0 DCT Euro 6',colour:'blue',location:'Milton Keynes, United Kingdom',
  mileage:52400,price:24500
}));
check('matching colour mileage and town overrules different prices',
      duplicate(tripleA,tripleB),true);
check('three priority fields can match even with no advertised price',
      duplicate({...tripleA,price:null},{...tripleB,price:null}),true);
check('same three signals with no year is still strong enough',
      duplicate({...tripleA,year:null},{...tripleB,year:null}),true);
check('normalise country suffix and distance on location',
      normalLocation(tripleA.location)===normalLocation(tripleB.location),true);
check('near mileage with same colour and location still matches',
      duplicate(tripleA,{...tripleB,mileage:52900}),true);
check('meaningfully different miles are never combined',
      duplicate(tripleA,{...tripleB,mileage:59000,price:23500}),false);
check('seller distance must not masquerade as vehicle odometer mileage',
      duplicate(paint(car('autotrader:201','autotrader',{
        mileage:120,location:'Milton Keynes (120 miles)',colour:'blue'})),
        paint(car('facebook:202','facebook',{
        mileage:120,location:'Milton Keynes',colour:'blue'}))),false);
check('different confirmed exterior colours are not merged',
      duplicate(tripleA,{...tripleB,colour:'red',price:23500}),false);
check('unknown paint does not count as matching blue',
      duplicate(tripleA,{...tripleB,colourSource:'unknown',location:'Leeds',price:24500}),false);
check('silver grey label ambiguity is not treated as exact colour equality',
      duplicate({...tripleA,colour:'grey',location:'',mileage:null},
                {...tripleB,colour:'silver',location:'',mileage:null}),false);
check('matching mileage and town with equal price works without colour',
      duplicate(car('autotrader:10','autotrader',{mileage:52000,
        location:'Sutton Coldfield'}),
        car('ebay:11','ebay',{mileage:52300,location:'Sutton Coldfield'})),true);
check('matching mileage and town with changed price and strong title works',
      duplicate(car('autotrader:12','autotrader',{mileage:52000,location:'Luton'}),
        car('ebay:13','ebay',{mileage:52300,location:'Luton',price:24900})),true);
check('matching mileage and colour with equal price works without location',
      duplicate(paint(car('autotrader:14','autotrader',{mileage:52000,colour:'blue'})),
        paint(car('facebook:15','facebook',{mileage:52300,colour:'blue',
          title:'BMW M2 3.0 DCT Euro 6'}))),true);
check('colour and town need same price and distinctive title/year',
      duplicate(paint(car('autotrader:16','autotrader',{colour:'blue',location:'Birmingham'})),
        paint(car('ebay:17','ebay',{colour:'blue',location:'Birmingham'}))),true);
check('colour and town alone with changed price cannot merge',
      duplicate(paint(car('autotrader:18','autotrader',{colour:'blue',location:'Birmingham'})),
        paint(car('facebook:19','facebook',{colour:'blue',location:'Birmingham',price:24900}))),false);
check('colour by itself at same price cannot merge',
      duplicate(paint(car('autotrader:20','autotrader',{colour:'blue'})),
        paint(car('facebook:21','facebook',{colour:'blue'}))),false);
check('transmission by itself at same price cannot merge',
      duplicate(car('autotrader:22','autotrader',{transmission:'automatic'}),
        car('facebook:23','facebook',{transmission:'automatic'})),false);
check('different known gearboxes veto merge',
      duplicate({...tripleA,transmission:'manual'},
        {...tripleB,transmission:'automatic'}),false);
check('conflicting registrations veto even three matching signals',
      duplicate({...tripleA,registration:'AA17 ABC'},
        {...tripleB,registration:'BB17 XYZ'}),false);
// A pair of near-identical, locally computed perceptual photo fingerprints.
const photoA={p:'8ff18c7ca126ef03',d:'18c93f1a0e8fd51c',rgb:[101,108,111]};
const photoB={p:'8ff18c7ca126ef03',d:'18c93f1a0e8fd51c',rgb:[102,107,111]};
const photoFar={p:'0070700f0fff0f0f',d:'ff01efee10aaaa00',rgb:[190,45,90]};
const photoLeft=paint(car('autotrader:200','autotrader',{
  title:'2017 BMW M2',mileage:null,location:'Birmingham',
  price:23500,colour:'blue',photoHash:photoA
}));
const photoRight=paint(car('facebook:201','facebook',{
  title:'BMW M2 DCT',mileage:null,location:'Birmingham',
  price:24900,colour:'blue',photoHash:photoB
}));
check('very strong independent pHash/dHash photo comparison',
      photoSimilarity(photoLeft,photoRight).matched,true);
check('very high image score can merge despite changed price and missing mileage',
      duplicate(photoLeft,photoRight),true);
check('same model but different image does not merge from photo',
      photoSimilarity(photoLeft,{...photoRight,photoHash:photoFar}).matched,false);
check('invalid remote image fingerprints are not accepted',
      photoSimilarity(photoLeft,{...photoRight,photoHash:{p:'junk',d:'junk',rgb:[0,0,0]}}),null);
check('photo match cannot override different vehicle models',
      duplicate(photoLeft,{...photoRight,title:'2017 BMW M4',photoHash:photoA}),false);
check('photo match cannot override conflicting registration numbers',
      duplicate({...photoLeft,registration:'AA17 ABC'},{
        ...photoRight,registration:'BB17 XYZ',photoHash:photoA}),false);
check('photo match cannot override known conflicting mileage',
      duplicate({...photoLeft,mileage:51000},{
        ...photoRight,mileage:78000,photoHash:photoA}),false);
check('same stock-looking image but no supporting advert information stays separate',
      duplicate(car('autotrader:210','autotrader',{price:21000,photoHash:photoA}),
        car('facebook:211','facebook',{price:25000,photoHash:photoA})),false);
state.separateDuplicates[duplicatePairKey(photoLeft.id,photoRight.id)]=true;
check('Not same car overrides identical photographs',
      duplicate(photoLeft,photoRight),false);
delete state.separateDuplicates[duplicatePairKey(photoLeft.id,photoRight.id)];
check('matching registration overrides price and missing metadata',
      duplicate(car('autotrader:24','autotrader',{registration:'AB17 CDE',price:21000}),
        car('ebay:25','ebay',{registration:'AB17 CDE',price:27000})),true);
check('year difference over one excludes otherwise same car',
      duplicate({...tripleA,year:2017},{...tripleB,year:2022}),false);
check('porsche 997 and 911 model identity and three signals',
      duplicate(paint(car('autotrader:26','autotrader',{
        title:'2006 Porsche 997 Carrera 4S',year:2006,
        colour:'grey',location:'Stockport',mileage:70000})),
        paint(car('pistonheads:27','pistonheads',{
        title:'Porsche 911 Carrera 4S',year:2006,
        colour:'grey',location:'Stockport',mileage:70250,price:26950}))),true);
const ga=paint(car('autotrader:30','autotrader',{
  title:'2017 BMW M2 Coupe',colour:'blue',location:'London',mileage:55000
}));
const gb=paint(car('pistonheads:31','pistonheads',{
  title:'BMW M2 3.0 DCT',colour:'blue',location:'London',mileage:55000
}));
const gc=paint(car('facebook:32','facebook',{
  title:'BMW M2 3.0 DCT',colour:'blue',location:'Leeds',mileage:55000,price:24500
}));
const groups=grouped([ga,gb,gc]);
check('non-transitive matches do not chain distinct cars',groups.length,2);
check('correct first pair grouped',groups[0].length,2);
check('two same-site adverts never grouped automatically',
      grouped([ga,gb,car('autotrader:33','autotrader',{
        title:'2017 BMW M2 Coupe',location:'London',mileage:55000,
        colour:'blue',colourSource:'explicit'})]).length,2);
state.separateDuplicates[duplicatePairKey(ga.id,gb.id)]=true;
check('user Not same car decision overrides identical triple evidence',
      duplicate(ga,gb),false);
check('stored separation splits already matching cars',
      grouped([ga,gb]).length,2);
delete state.separateDuplicates[duplicatePairKey(ga.id,gb.id)];
check('user can allow matching again',duplicate(ga,gb),true);
state.manualDuplicates[gb.id]=ga.id;
check('manual merge overrides price and geography',duplicate(
  car(ga.id,'autotrader',{price:21000}),
  car(gb.id,'pistonheads',{price:27000,location:'Leeds'})),true);
console.log('priority duplicate matching assertions passed');
"""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        suite_path=Path(td)/"assertions.js"
        suite_path.write_text(suite,encoding="utf-8")
        result=subprocess.run(["node","-e",script,str(source),str(suite_path)],
                              text=True,capture_output=True,timeout=15)
    assert result.returncode==0,result.stderr
    assert "duplicate matching assertions passed" in result.stdout


@pytest.mark.asyncio
async def test_user_can_persistently_separate_and_reallow_matching(monkeypatch,tmp_path):
    monkeypatch.setattr(server,"DATA_DIR",tmp_path)
    monkeypatch.setattr(server,"DATA_FILE",tmp_path/"saved-cars.json")
    monkeypatch.setattr(server,"PASSWORD","")
    monkeypatch.setattr(server,"state",{**server.fresh_state(),
        "listings":{
          "autotrader:123":{"id":"autotrader:123","site":"autotrader",
                            "title":"BMW M2","saved":True},
          "ebay:456":{"id":"ebay:456","site":"ebay",
                      "title":"BMW M2","saved":False},
        }, "manualDuplicates":{"ebay:456":"autotrader:123"}})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app),
                                 base_url="http://testserver") as client:
        response=await client.post("/api/duplicates",json={
            "separateIds":["autotrader:123","ebay:456"]})
        assert response.status_code==200,response.text
        state=response.json()["state"]
        assert state["separateDuplicates"]["autotrader:123|ebay:456"] is True
        assert state["manualDuplicates"]=={}
        assert state["listings"]["autotrader:123"]["saved"] is True
        assert "separateDuplicates" in (tmp_path/"saved-cars.json").read_text()
        response=await client.post("/api/duplicates",json={
            "clearSeparateIds":["autotrader:123"]})
        assert response.status_code==200,response.text
        assert response.json()["state"]["separateDuplicates"]=={}
        response=await client.post("/api/duplicates",json={
            "separateIds":["autotrader:123","unknown:789"]})
        assert response.status_code==400


def test_user_can_split_group_and_undo_from_listing_card():
    source=(Path(__file__).resolve().parents[1]/"public/dashboard.js").read_text()
    assert 'data-action="separate"' in source
    assert 'data-action="allow-match"' in source
    assert "separateIds:ids" in source
    assert "clearSeparateIds:ids" in source
