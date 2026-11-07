// What the end-to-end test (e2e-joinly.mjs) needs from the TypeScript side: the fake joinly
// server, and the same checks the app uses to say what an approval card should read.
// e2e-joinly.mjs bundles this with esbuild before it starts.
export { FakeJoinly } from './fakeJoinly';
export { JOINLY_START_COMMAND, validateMeetingCall, reviewMeeting } from '../shared/joinly';
