// The .mpp reader beside a bundle: mpxj/lib/ with MPXJ (LGPL-2.1+, used unmodified) and the jars it needs to read .mpp
// and write Microsoft Project XML, each pinned by its SHA-256 (fetched from Maven Central once into .cache/mpxj/), and
// mpxj/jre/<os>-<arch>/ with a Java runtime made by jlink of only the modules they use. core/msp/mpp.ts runs it.
// Not a node_modules folder: the White Hat IQ platform's signed manifest and patch builder skip those.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CENTRAL = 'https://repo1.maven.org/maven2';
/** [Maven path (group/artifact/version/file), SHA-256, licence] */
export const MPXJ_JARS = [
  ['net/sf/mpxj/mpxj/16.10.0/mpxj-16.10.0.jar', '0004751793726e73e81b71160a1ed7dd7bdeb80fc2d42484d0504a464a6eddb7', 'LGPL-2.1-or-later'],
  ['org/apache/poi/poi/5.5.1/poi-5.5.1.jar', '6c52e876ca75775a11b56e4b36a7541f682827f56406725fcd87560b792ee3d8', 'Apache-2.0'],
  ['commons-codec/commons-codec/1.20.0/commons-codec-1.20.0.jar', '6af66595f9f6a7bb58ce66518d6888d40b547c366d2262f06676eee19528ff66', 'Apache-2.0'],
  ['org/apache/commons/commons-collections4/4.5.0/commons-collections4-4.5.0.jar', '00f93263c267be201b8ae521b44a7137271b16688435340bf629db1bac0a5845', 'Apache-2.0'],
  ['org/apache/commons/commons-math3/3.6.1/commons-math3-3.6.1.jar', '1e56d7b058d28b65abd256b8458e3885b674c1d588fa43cd7d1cbb9c7ef2b308', 'Apache-2.0'],
  ['commons-io/commons-io/2.21.0/commons-io-2.21.0.jar', '7d643a2afea8b058b762aa6fb90e5b256f6c729739f8b3784c3370ddc609e88d', 'Apache-2.0'],
  ['com/zaxxer/SparseBitSet/1.3/SparseBitSet-1.3.jar', 'f76b85adb0c00721ae267b7cfde4da7f71d3121cc2160c9fc00c0c89f8c53c8a', 'Apache-2.0'],
  ['org/apache/logging/log4j/log4j-api/2.24.3/log4j-api-2.24.3.jar', '5b4a0a0cd0e751ded431c162442bdbdd53328d1f8bb2bae5fc1bbeee0f66d80f', 'Apache-2.0'],
  ['jakarta/xml/bind/jakarta.xml.bind-api/3.0.1/jakarta.xml.bind-api-3.0.1.jar', 'b8fb4bee3ff5b5c1ef77144d8411316018d7bbd41fcf1ede0646f7978546b867', 'EDL-1.0 (BSD-3-Clause)'],
  ['org/glassfish/jaxb/jaxb-runtime/3.0.2/jaxb-runtime-3.0.2.jar', '7b3a3784b9c6e343a8d38fc108602ba810177f03f2d8d1e7258b1cef7fd9d4c7', 'EDL-1.0 (BSD-3-Clause)'],
  ['org/glassfish/jaxb/jaxb-core/3.0.2/jaxb-core-3.0.2.jar', 'f9a360b939597643b2676e35fc497afb561d20e8a513128a5c0070366db11bbd', 'EDL-1.0 (BSD-3-Clause)'],
  ['org/glassfish/jaxb/txw2/3.0.2/txw2-3.0.2.jar', 'b4bcf94fb0a759456e2521724513baec94b78e93127544af162e3cff08d93343', 'EDL-1.0 (BSD-3-Clause)'],
  ['com/sun/istack/istack-commons-runtime/4.0.1/istack-commons-runtime-4.0.1.jar', '9f91115f449384886f572bd62c8812ee1004273d4b5c85cac65179ad4c16990f', 'EDL-1.0 (BSD-3-Clause)'],
  ['com/sun/activation/jakarta.activation/2.0.1/jakarta.activation-2.0.1.jar', 'b9e24b7dd6e07495562ea96531be3130c96dba4d78e1dfd88adbbdebf4332871', 'EDL-1.0 (BSD-3-Clause)'],
  ['com/github/joniles/rtfparserkit/1.16.0/rtfparserkit-1.16.0.jar', 'aa13625c4a9fc0234caf5e13a6cc3f44ce0d34c5541bb4b1d8ecaf52cb031237', 'Apache-2.0'],
  ['org/jsoup/jsoup/1.23.1/jsoup-1.23.1.jar', '8b15e2b28eeb1e0a88a9b7dab4dc0c23524491c56959785dea22f7846897b668', 'MIT'],
  ['com/fasterxml/jackson/core/jackson-core/2.22.3/jackson-core-2.22.3.jar', '8a501126a385b25841915d839508f8a66e2a0dbc8a6709d055ef3b3e852b094c', 'Apache-2.0'],
  ['com/fasterxml/jackson/core/jackson-databind/2.22.3/jackson-databind-2.22.3.jar', '556db5439e206114346043f68d200497dc96a0bca62a360a81784092ebd0e0a9', 'Apache-2.0'],
  ['com/fasterxml/jackson/core/jackson-annotations/2.22/jackson-annotations-2.22.jar', '21ddb598807d3a51a876704eb979d9296e1c6a6f47ab1826ff88c6d6a127a2d0', 'Apache-2.0'],
];
/** The Java modules MPXJ and its jars use (jdeps; java.desktop for its colours, jdk.charsets for MacRoman and kin). */
export const JRE_MODULES = 'java.base,java.desktop,java.logging,java.sql,java.xml,java.naming,jdk.unsupported,jdk.charsets';

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
/** The jars in .cache/mpxj/, fetched from Maven Central when missing; each must match its pinned SHA-256. */
export async function fetchMpxj(root) {
  const dir = join(root, '.cache', 'mpxj');
  mkdirSync(dir, { recursive: true });
  for (const [path, hash] of MPXJ_JARS) {
    const f = join(dir, path.split('/').pop());
    if (!existsSync(f) || sha256(f) !== hash) {
      const res = await fetch(`${CENTRAL}/${path}`);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    }
    if (sha256(f) !== hash) throw new Error(`${path}: its SHA-256 is not the pinned one (a changed or damaged download)`);
  }
  return dir;
}

/** mpxj/ beside a bundle: lib/ (the jars), README.txt (versions, licences, sources), and jre/<os>-<arch>/ for each runtime
 *  P6CLONE_JRE_TARGETS names ({"win-x64": "<a JDK's jmods>", ...}, linked by P6CLONE_JLINK, a jlink of the same JDK
 *  version), else none (the machine's own Java is used). */
export async function copyMpxj(root, dest) {
  const src = await fetchMpxj(root), out = join(dest, 'mpxj');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'lib'), { recursive: true });
  for (const [path] of MPXJ_JARS) cpSync(join(src, path.split('/').pop()), join(out, 'lib', path.split('/').pop()));
  // the licence texts: LGPL-2.1 asks that MPXJ's be supplied with it (the jar does not carry it), and Apache-2.0 asks the same of the Apache jars
  for (const f of ['LICENSE-LGPL-2.1.txt', 'LICENSE-Apache-2.0.txt']) cpSync(join(dirname(fileURLToPath(import.meta.url)), 'licenses', f), join(out, f));
  const targets = process.env.P6CLONE_JRE_TARGETS ? JSON.parse(process.env.P6CLONE_JRE_TARGETS) : {};
  for (const [target, jmods] of Object.entries(targets)) {
    const r = spawnSync(process.env.P6CLONE_JLINK || 'jlink', ['--module-path', jmods, '--add-modules', JRE_MODULES, '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=zip-9', '--output', join(out, 'jre', target)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`jlink for ${target}: ${r.stderr || r.error}`);
  }
  writeFileSync(join(out, 'README.txt'), [
    'The .mpp reader (core/msp/mpp.ts): MPXJ turns a Microsoft Project .mpp into Microsoft Project XML, which the clone reads.',
    'Run as: java -cp "lib/*" org.mpxj.sample.MpxjConvert <in.mpp> <out.xml>. MPXJ and every jar here are used unmodified.',
    'Licences: MPXJ is LGPL-2.1-or-later, and its text is LICENSE-LGPL-2.1.txt beside this file (the jar does not carry it); the Apache-2.0 jars are under',
    'LICENSE-Apache-2.0.txt; the jars that carry their own licence text keep it in META-INF. You may replace lib/mpxj-*.jar with your own build of MPXJ.',
    'Sources: https://repo1.maven.org/maven2/<path> (-sources.jar beside each jar; MPXJ: https://github.com/joniles/mpxj).',
    '',
    ...MPXJ_JARS.map(([path, hash, lic]) => `lib/${path.split('/').pop()}  ${lic}  sha256 ${hash}`),
    '',
    Object.keys(targets).length ? `jre/: Java runtimes made by jlink (OpenJDK, GPL-2.0 with the Classpath Exception; licences in jre/<os>-<arch>/legal/) for ${Object.keys(targets).join(', ')}; modules ${JRE_MODULES}.` : 'No Java runtime is shipped in this build: the machine\'s own Java runs MPXJ (P6CLONE_JAVA names it; every jar here is built for Java 8, and the runtimes shipped by other builds are Java 21).',
    '',
  ].join('\n'));
  return out;
}
