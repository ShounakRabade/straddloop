# Day-file parity, step 2: write the rows into a Parquet store. See run.sh.
import json, sys
from datetime import datetime
from pathlib import Path
from straddloop.data import store
from straddloop.data.schema import OptionCandle, UnderlyingCandle
d = json.load(open(sys.argv[2]))
root = Path(sys.argv[1])
u = [UnderlyingCandle(datetime.fromisoformat(r['ts']), 'NIFTY', 1, r['o'], r['h'], r['l'], r['c'], None, 'dhan') for r in d['und']]
o = [OptionCandle(datetime.fromisoformat(r['ts']), 'NIFTY', 1, r['cp'], float(r['k']), 'ATM' if r['off']==0 else f"ATM{r['off']:+d}", 'WEEK', 1, None,
     r['o'], r['h'], r['l'], r['c'], 100.0, 1000.0, 12.5, r['spot'], 'dhan') for r in d['opt']]
store.write_records(root, 'underlying_candles', u, UnderlyingCandle)
store.write_records(root, 'option_candles', o, OptionCandle)
