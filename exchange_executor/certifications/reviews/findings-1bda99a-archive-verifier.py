"""Independently re-read completed evidence archive; no receipt/pin mutation."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

ROOT = Path.cwd()
R = ROOT / 'reports/findings-review'
def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)

parser = argparse.ArgumentParser()
parser.add_argument('--tag', required=True)
args = parser.parse_args()
require(re.fullmatch(r'[a-zA-Z0-9_-]+', args.tag), 'Invalid evidence tag.')
path = R / f'{args.tag}-receipt-evidence.tar.gz'
raw = path.read_bytes()
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
    members = archive.getmembers()
    require(len({m.name for m in members}) == len(members), 'Archive contains duplicate member names.')
    require(all(m.isfile() and not m.issym() and not m.islnk() and m.mtime == m.uid == m.gid == 0
               and m.mode == 0o444 and m.uname == m.gname == '' for m in members), 'Archive member type or canonical metadata is invalid.')
    payload = {m.name: archive.extractfile(m).read() for m in members}
manifest_bytes = (R / f'{args.tag}-receipt-evidence-manifest.json').read_bytes()
require(payload['manifest.json'] == manifest_bytes, 'Archived manifest differs from the local manifest.')
manifest = json.loads(manifest_bytes)
expected_names = {'manifest.json'} | {row['member'] for row in manifest['files']}
require(set(payload) == expected_names and len(expected_names) == len(manifest['files']) + 1, 'Archive member set does not match the manifest.')
for row in manifest['files']:
    require(row['member'] == 'review/' + row['path'], 'Manifest member is not bound to its review path.')
    require(row['path'].startswith('reports/findings-review/') and '..' not in Path(row['path']).parts, 'Manifest path is outside the review directory.')
    value = payload[row['member']]
    require(sha(value) == row['sha256'] and len(value) == row['bytes'], 'Archive member hash or byte count does not match the manifest.')
    require((ROOT / row['path']).read_bytes() == value, 'Archive member differs from its current local file.')
for binding in manifest['verifiedReferences']:
    if binding['kind'] == 'current-file':
        require(sha((ROOT / binding['path']).read_bytes()) == binding['sha256'], 'Current reference file hash does not match its binding.')
    else:
        reference = binding['archive']
        archive_path = ROOT / reference['path']
        require(sha(archive_path.read_bytes()) == reference['sha256'], 'Historical reference archive hash does not match its binding.')
        with tarfile.open(archive_path) as previous:
            require(sha(previous.extractfile(binding['member']).read()) == binding['sha256'], 'Historical reference member hash does not match its binding.')
prefix = 'review/reports/findings-review/'
state = json.loads(payload[prefix + f'{args.tag}-receipt-candidate-state.json'])
review = json.loads(payload[prefix + f'{args.tag}-independent-receipt-review.json'])
approval = json.loads(payload[prefix + f'{args.tag}-receipt-adoption-approval.json'])
require(review['candidate'] == approval['candidate'] == state['candidate'] and approval['approved'] is True, 'Candidate state, independent review, and explicit approval do not agree.')
require(review['revision'] == state['revision'] == manifest['sourceRevision'], 'Review, candidate state, and manifest source revisions do not agree.')
require(manifest['unresolvedReferences'] == [] and manifest['providerAcceptanceVerified'] is False, 'Manifest has unresolved references or claims provider acceptance.')
require(review['referenceClosure']['unresolvedReferences'] == 0, 'Independent review has unresolved references.')
require(review['checks']['productionPythonValidation'] == 'PASS', 'Production Python validation did not pass.')
require(review['checks']['productionNodeComparison']['buildInputsMatch'] is True, 'Production Node comparison did not match build inputs.')
require(sha(payload['review/' + state['candidate']['path']]) == state['candidate']['sha256'], 'Archived candidate hash does not match candidate state.')
for binding in review['referenceClosure']['currentFiles']:
    if binding['path'].startswith('reports/findings-review/'):
        require(sha(payload['review/' + binding['path']]) == binding['sha256'], 'Archived review reference hash does not match its binding.')
for historical in review['referenceClosure']['historicalLeaves']:
    require(historical in manifest['inheritedExactReferences'], 'Historical leaf is missing from inherited exact references.')

# Independently reconstruct bytes from unpacked members and their verified
# canonical metadata, rather than invoking the packer's implementation.
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as tar:
    for name, contents in payload.items():
        member = tarfile.TarInfo(name)
        member.size, member.mode = len(contents), 0o444
        member.uid = member.gid = member.mtime = 0
        member.uname = member.gname = ''
        tar.addfile(member, io.BytesIO(contents))
compressed = io.BytesIO()
with gzip.GzipFile(filename='', fileobj=compressed, mode='wb', mtime=0, compresslevel=9) as stream:
    stream.write(buffer.getvalue())
require(compressed.getvalue() == raw, 'Independent archive rebuild differs from the original bytes.')
print(json.dumps({'kind': 'separate-completed-archive-verification',
    'archive': {'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(raw)},
    'candidate': state['candidate'], 'members': len(payload), 'everyMemberReadBack': True,
    'independentRebuildByteIdentical': True, 'currentAndHistoricalReferencesRechecked': True,
    'candidateIndependentReviewAndRootApprovalBound': True, 'unresolvedReferences': 0,
    'operativeReceiptOrPinsChanged': False}, indent=2))
