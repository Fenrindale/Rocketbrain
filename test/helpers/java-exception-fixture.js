'use strict';

const path = require('node:path');

function exceptionFixture(base) {
  const mainClass = base + '.app.ExceptionFilterFixture';
  const exceptionType = mainClass + '$TrackedFailure';
  const main = [
    'package ' + base + '.app;',
    'import ' + base + '.app.vendor.LibrarySite;',
    'import ' + base + '.external.OutsideSite;',
    'public class ExceptionFilterFixture {',
    '    public static class TrackedFailure extends RuntimeException {',
    '        public TrackedFailure(String message) { super(message); }',
    '    }',
    '    public static class ChildFailure extends TrackedFailure {',
    '        public ChildFailure(String message) { super(message); }',
    '    }',
    '    public static class AlternateFailure extends RuntimeException {}',
    '    public static void main(String[] args) {',
    '        String mode = args.length == 0 ? "" : args[0];',
    '        try { throw new IllegalArgumentException("other-type"); } catch (IllegalArgumentException ignored) {}',
    '        try { LibrarySite.fire(); } catch (RuntimeException ignored) {}',
    '        try { OutsideSite.fire(); } catch (RuntimeException ignored) {}',
    '        try { throw new ChildFailure("wanted-caught"); } catch (RuntimeException ignored) {}',
    '        if ("multiple".equals(mode)) {',
    '            try { throw new AlternateFailure(); } catch (RuntimeException ignored) {} // wanted-alternate',
    '        }',
    '        if ("uncaught".equals(mode)) throw new ChildFailure("wanted-uncaught");',
    '        System.out.println("EXCEPTION_FIXTURE_COMPLETED");',
    '    }',
    '}',
    ''
  ].join('\n');
  const vendor = [
    'package ' + base + '.app.vendor;',
    'import ' + mainClass + '.TrackedFailure;',
    'public class LibrarySite {',
    '    public static void fire() { throw new TrackedFailure("excluded-library"); }',
    '}',
    ''
  ].join('\n');
  const outside = [
    'package ' + base + '.external;',
    'import ' + mainClass + '.TrackedFailure;',
    'public class OutsideSite {',
    '    public static void fire() { throw new TrackedFailure("outside-allowlist"); }',
    '}',
    ''
  ].join('\n');
  const source = path.join(...mainClass.split('.')) + '.java';
  return {
    mainClass, exceptionType, childType: mainClass + '$ChildFailure', alternateType: mainClass + '$AlternateFailure', source,
    policy: {
      exceptionTypes: [exceptionType],
      allowClasses: [base + '.app.*'],
      skipClasses: [base + '.app.vendor.*']
    },
    files: [
      [source, main],
      [path.join(...base.split('.'), 'app', 'vendor', 'LibrarySite.java'), vendor],
      [path.join(...base.split('.'), 'external', 'OutsideSite.java'), outside]
    ],
    line: marker => main.split('\n').findIndex(row => row.includes(marker)) + 1
  };
}

module.exports = { exceptionFixture };
