import {performance} from 'node:perf_hooks';
import {prepareWindowsOwnerPolicyFixture} from '../dist/tests/unit/windows-owner-policy-fixture.js';

// Windows CI environment conditioning only: no production checker, ignored
// policy case, token mutation, filesystem ACL write or retry occurs here.
const started=performance.now();
const preparation=prepareWindowsOwnerPolicyFixture();
console.log(JSON.stringify({preparation,elapsedMs:performance.now()-started,scope:'test-only in-memory metadata classes'}));
