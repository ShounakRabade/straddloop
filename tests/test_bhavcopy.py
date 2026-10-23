"""UDiFF bhavcopy parsing on a hand-written two-row file (test fixture, not market data)."""

import pytest

from straddloop.reference.bhavcopy import BhavcopyFormatError, parse_nse_udiff

HEADER = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,"
          "StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,"
          "SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks")


def test_parses_options_only(tmp_path):
    f = tmp_path / "bhav.csv"
    f.write_text("\n".join([
        HEADER,
        "2026-10-20,2026-10-20,FO,NSE,IDO,1,,NIFTY,,2026-10-27,2026-10-27,25000,CE,X,1,2,0.5,1.5,1.5,1,"
        "24900,1.5,100,0,10,1,5,F1,65,",
        "2026-10-20,2026-10-20,FO,NSE,IDF,2,,NIFTY,,2026-10-27,2026-10-27,,,X,1,2,0.5,1.5,1.5,1,"
        "24900,1.5,100,0,10,1,5,F1,65,",
    ]))
    rows = parse_nse_udiff(f)
    assert len(rows) == 1
    r = rows[0]
    assert (r.symbol, r.strike, r.option_type, r.lot_size) == ("NIFTY", 25000.0, "CE", 65)
    assert r.expiry.isoformat() == "2026-10-27"


def test_rejects_unknown_layout(tmp_path):
    f = tmp_path / "old.csv"
    f.write_text("INSTRUMENT,SYMBOL,EXPIRY_DT\nOPTIDX,NIFTY,27-Oct-2026\n")
    with pytest.raises(BhavcopyFormatError):
        parse_nse_udiff(f)
