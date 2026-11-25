'use strict';

const assert = require('node:assert/strict');

function constantFixture(packageName, className) {
  const common = '(BASE << 2) + 9';
  const other = '"tag-" + "Ω"';
  const source = `package ${packageName};

public class ${className} extends ${className}Parent {
    private static final int BASE = 5;
    private static final int TAKEN = 17;
    private int mutable = 3;

    public int identical() { return ${common}; }
    public int selected() { return ${common}; }
    public String text() { return ${other}; }
    public int variable() { return mutable + 1; }
    public double call() { return Math.random() * 7; }
    public int scoped() { final int FIXED = 8; return FIXED * 2; }
    public int local() { int SHADOW = 91; return SHADOW; }

    public static void main(String[] args) {
        var fixture = new ${className}();
        System.out.println(fixture.identical() + ":" + fixture.selected() + ":" + fixture.text());
    }
}

class ${className}Parent {
    protected static final int INHERITED = 99;
}
`;
  const selection = value => {
    const start = value === common ? source.lastIndexOf(value) : source.indexOf(value);
    assert.ok(start >= 0, value);
    return {start,end:start + value.length};
  };
  return { source, packageName, className, common, other, selection, output:'29:29:tag-Ω' };
}

function assertOnlySelectedConstant(fixture, after, name) {
  assert.ok(after.includes(`private static final int ${name} = ${fixture.common};`));
  assert.ok(after.includes(`public int selected() { return ${name}; }`));
  assert.ok(after.includes(`public int identical() { return ${fixture.common}; }`));
  assert.ok(after.includes('return Math.random() * 7;'));
}

module.exports = { constantFixture, assertOnlySelectedConstant };
