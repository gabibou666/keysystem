'use strict';
const {SCANNER_VERSION}=require('./script-safety');
// The aliases l/s/rc/rf are shared by catalogue and publication statistics.
// A human approval never substitutes for a proof of the exact scanned bytes.
const proofJoins="LEFT JOIN developer_script_revalidation rc ON rc.project_id=l.project_id AND rc.target_kind='current' LEFT JOIN developer_script_revalidation rf ON rf.project_id=l.project_id AND rf.target_kind='free_snapshot'";
const currentVerified=`s.safety_status='clear' AND s.validated=true AND s.scanner_version='${SCANNER_VERSION}' AND length(s.build_hash)=64 AND s.safety_hash=s.build_hash AND rc.result='clear' AND rc.scanner_version='${SCANNER_VERSION}' AND rc.content_version=s.version AND rc.content_hash=s.build_hash`;
const snapshotVerified=`l.safety_status='clear' AND l.snapshot_validated=true AND length(l.safety_hash)=64 AND rf.result='clear' AND rf.scanner_version='${SCANNER_VERSION}' AND rf.content_version=l.script_version AND rf.content_hash=l.safety_hash`;
const listingVerified=`l.safety_status='clear' AND ${currentVerified} AND (l.access_mode='licensed' OR (l.access_mode='free' AND ${snapshotVerified}))`;
module.exports={proofJoins,currentVerified,snapshotVerified,listingVerified};
