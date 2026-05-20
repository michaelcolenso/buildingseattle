import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sdci_detail_probe import parse_detail_html
from sdci_enrich import flatten_enrichment


def test_parse_detail_html_extracts_contractor_disclosure_and_housing_fields():
    html = """
    <span id="ctl00_PlaceHolderMain_lblRecordStatus">Issued</span>
    <span id="ctl00_PlaceHolderMain_lblExpirtionDate">12/26/2026</span>
    <tr id="trASIList">
      <div class="MoreDetail_ItemColASI MoreDetail_ItemCol1"><span class="ACA_SmLabelBolder font11px">Who will be performing all the work?: </span></div>
      <div class="MoreDetail_ItemColASI MoreDetail_ItemCol2"><span class="ACA_SmLabel ACA_SmLabel_FontSize">Licensed Contractor</span></div>
      <div class="MoreDetail_ItemColASI MoreDetail_ItemCol1"><span class="ACA_SmLabelBolder font11px">Contractor License: </span></div>
      <div class="MoreDetail_ItemColASI MoreDetail_ItemCol2"><span class="ACA_SmLabel ACA_SmLabel_FontSize">GREENBN861QE</span></div>
      <div class="MoreDetail_ItemColASI MoreDetail_ItemCol1"><span class="ACA_SmLabelBolder font11px">Review Level: </span></div>
      <div class="MoreDetail_ItemColASI MoreDetail_ItemCol2"><span class="ACA_SmLabel ACA_SmLabel_FontSize">Field</span></div>
    </tr>
    <tr id="trASITList">
      <div class="MoreDetail_ItemCol MoreDetail_ItemCol1"><span class="ACA_SmLabelBolder font11px">Number of Existing Units:</span></div>
      <div class="MoreDetail_ItemCol MoreDetail_ItemCol2"><span class="ACA_SmLabel ACA_SmLabel_FontSize">1</span></div>
      <div class="MoreDetail_ItemCol MoreDetail_ItemCol1"><span class="ACA_SmLabelBolder font11px">Number of Sleeping Rooms:</span></div>
      <div class="MoreDetail_ItemCol MoreDetail_ItemCol2"><span class="ACA_SmLabel ACA_SmLabel_FontSize">3</span></div>
    </tr>
    <div>Development Site Parcel:DV1200889</div>
    """

    result = parse_detail_html("PERM456", html)

    assert result["record_status"] == "Issued"
    assert result["expiration_date"] == "12/26/2026"
    assert result["parcel"] == "DV1200889"
    assert result["contractor_disclosure"]["performing_work"] == "Licensed Contractor"
    assert result["contractor_disclosure"]["contractor_license"] == "GREENBN861QE"
    assert result["application_info"]["Review Level"] == "Field"
    assert result["other_info"]["Number of Sleeping Rooms"] == "3"


def test_flatten_enrichment_prefers_lni_business_name():
    result = {
        "permit_number": "PERM456",
        "detail_url": "https://example.com/detail",
        "record_status": "Issued",
        "expiration_date": "12/26/2026",
        "parcel": "DV1200889",
        "contractor_disclosure": {
            "performing_work": "Licensed Contractor",
            "contractor_license": "GREENBN861QE",
        },
        "contractor_license_lookup": {
            "businessname": "Green Built Northwest LLC",
            "licensestatusdesc": "ACTIVE",
            "ubi": "603448643",
        },
        "application_info": {"Review Level": "Field"},
        "other_info": {"Number of Existing Units": "1"},
    }

    flattened = flatten_enrichment(result)

    assert flattened["contractor_name"] == "Green Built Northwest LLC"
    assert flattened["contractor_license"] == "GREENBN861QE"
    assert flattened["contractor_license_status"] == "ACTIVE"
    assert flattened["review_level"] == "Field"
    assert flattened["housing_units_existing"] == "1"
