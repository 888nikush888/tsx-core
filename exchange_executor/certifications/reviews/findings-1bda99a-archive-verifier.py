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
sha = lambda raw: hashlib.sha256(raw).hexdigest()
parser = argparse.ArgumentParser()
parser.add_argument('--tag', required=True)
args = parser.parse_args()
assert re.fullmatch(r'[a-zA-Z0-9_-]+', args.tag)
path = R / f'{args.tag}-receipt-evidence.tar.gz'
raw = path.read_bytes()
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
    members = archive.getmembers()
    assert len({m.name for m in members}) == len(members)
    assert all(m.isfile() and not m.issym() and not m.islnk() and m.mtime == m.uid == m.gid == 0
               and m.mode == 0o444 and m.uname == m.gname == '' for m in members)
    payload = {m.name: archive.extractfile(m).read() for m in members}
manifest_bytes = (R / f'{args.tag}-receipt-evidence-manifest.json').read_bytes()
assert payload['manifest.json'] == manifest_bytes
manifest = json.loads(manifest_bytes)
expected_names = {'manifest.json'} | {row['member'] for row in manifest['files']}
assert set(payload) == expected_names and len(expected_names) == len(manifest['files']) + 1
for row in manifest['files']:
    assert row['member'] == 'review/' + row['path']
    assert row['path'].startswith('reports/findings-review/') and '..' not in Path(row['path']).parts
    value = payload[row['member']]
    assert sha(value) == row['sha256'] and len(value) == row['bytes']
    assert (ROOT / row['path']).read_bytes() == value
for binding in manifest['verifiedReferences']:
    if binding['kind'] == 'current-file':
        assert sha((ROOT / binding['path']).read_bytes()) == binding['sha256']
    else:
        reference = binding['archive']
        archive_path = ROOT / reference['path']
        assert sha(archive_path.read_bytes()) == reference['sha256']
        with tarfile.open(archive_path) as previous:
            assert sha(previous.extractfile(binding['member']).read()) == binding['sha256']
prefix = 'review/reports/findings-review/'
state = json.loads(payload[prefix + f'{args.tag}-receipt-candidate-state.json'])
review = json.loads(payload[prefix + f'{args.tag}-independent-receipt-review.json'])
approval = json.loads(payload[prefix + f'{args.tag}-receipt-adoption-approval.json'])
assert review['candidate'] == approval['candidate'] == state['candidate'] and approval['approved'] is True
assert review['revision'] == state['revision'] == manifest['sourceRevision']
assert manifest['unresolvedReferences'] == [] and manifest['providerAcceptanceVerified'] is False
assert review['referenceClosure']['unresolvedReferences'] == 0
assert review['checks']['productionPythonValidation'] == 'PASS'
assert review['checks']['productionNodeComparison']['buildInputsMatch'] is True
assert sha(payload['review/' + state['candidate']['path']]) == state['candidate']['sha256']
for binding in review['referenceClosure']['currentFiles']:
    if binding['path'].startswith('reports/findings-review/'):
        assert sha(payload['review/' + binding['path']]) == binding['sha256']
for historical in review['referenceClosure']['historicalLeaves']:
    assert historical in manifest['inheritedExactReferences']

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
assert compressed.getvalue() == raw
print(json.dumps({'kind': 'separate-completed-archive-verification',
    'archive': {'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(raw)},
    'candidate': state['candidate'], 'members': len(payload), 'everyMemberReadBack': True,
    'independentRebuildByteIdentical': True, 'currentAndHistoricalReferencesRechecked': True,
    'candidateIndependentReviewAndRootApprovalBound': True, 'unresolvedReferences': 0,
    'operativeReceiptOrPinsChanged': False}, indent=2))
