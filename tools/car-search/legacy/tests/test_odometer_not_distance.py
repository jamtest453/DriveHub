"""Mileage comparisons must not use the distance to the seller."""
import subprocess
from pathlib import Path


def test_actual_extractor_ignores_seller_distance_as_odometer():
    source = Path(__file__).resolve().parents[1] / "src/extractor.js"
    script = r"""
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(process.argv[1],'utf8');
const from=source.indexOf('  const mileage = str => {');
const to=source.indexOf('  const year = str => {',from);
if(from<0 || to<0) throw new Error('Mileage source block not found');
const cases=[
  ['distance before mileage','Milton Keynes (120 miles)\nMileage 52,400 miles',52400],
  ['distance after mileage','54,000 miles\nNelson (26 miles)',54000],
  ['only location distance','Ripley (46 miles)',null],
  ['distance away before odometer','30 miles away\n55,000 miles driven',55000],
  ['explicit low odometer','Mileage: 250 miles\nLondon (20 miles)',250],
  ['only miles away','120 miles away',null]
];
const testCode = source.slice(from,to) +
  '\nfor (const [label,raw,expected] of cases) {' +
  '\n  const actual=mileage(raw);' +
  '\n  if(actual!==expected) throw new Error(label+": expected "+expected+" got "+actual);' +
  '\n}' +
  '\nconsole.log("Odometer vs seller-distance tests passed");';
vm.runInNewContext(testCode,{cases,console});
"""
    result = subprocess.run(["node", "-e", script, str(source)], text=True,
                            capture_output=True, timeout=12)
    assert result.returncode == 0, result.stderr
    assert "Odometer vs seller-distance tests passed" in result.stdout
