"""Exercise actual Marketplace DOM scraper with unlabelled towns like screenshot."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("node"), reason="Node required for extractor DOM test")
def test_facebook_marketplace_cards_extract_visible_unlabelled_towns():
    root=Path(__file__).resolve().parents[1]
    towns=["North Tidworth","Sutton Coldfield","Birmingham, United Kingdom",
           "Solihull","Stoke-on-Trent","Luton","Newcastle","New Mills"]
    script=r"""
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const towns=JSON.parse(fs.readFileSync(0,'utf8'));
async function scrape(town,index) {
  const line='£23,500\n2017 BMW M2 DCT\n'+town;
  const url='https://www.facebook.com/marketplace/item/'+(123450000000+index)+'/';
  const card={
    innerText:line,textContent:line,
    querySelectorAll(selector){return selector==='a[href]'?[anchor]:[];},
    querySelector(selector){return null;}
  };
  const anchor={href:url,innerText:'2017 BMW M2 DCT',textContent:'2017 BMW M2 DCT',
    closest(selector){return card;}};
  const doc={
    location:{href:'https://www.facebook.com/marketplace/search/?query=BMW+M2'},
    body:{innerText:line,textContent:line},
    title:'Marketplace',
    documentElement:{scrollHeight:1200},
    querySelectorAll(selector){return [anchor];}
  };
  const win={scrollTo(){}};
  const ctx={window:win,document:doc,URL,setTimeout:(fn,ms)=>fn(),
    console,Promise,RegExp};
  vm.runInNewContext(source,ctx);
  const result=await win.__CSH_SCRAPE__('facebook',10);
  return {got:result.items[0]?.location||'',len:result.items.length};
}
Promise.all(towns.map(scrape)).then(rows=>process.stdout.write(JSON.stringify(rows)))
  .catch(err=>{console.error(err);process.exit(1)});
"""
    result=subprocess.run(["node","-e",script,str(root/"src/extractor.js")],
        input=json.dumps(towns),capture_output=True,text=True,timeout=15)
    assert result.returncode==0, result.stderr
    rows=json.loads(result.stdout)
    assert [x["got"] for x in rows]==towns
    assert all(x["len"]==1 for x in rows)
