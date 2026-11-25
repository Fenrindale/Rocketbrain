'use strict';

const assert = require('node:assert/strict');

function namedExtractionFixture(packageName,className) {
  const expression = 'bump(input) * 2';
  const source = `package ${packageName};

public class ${className} extends ${className}Parent {
    private int evaluations;
    private int otherField;

    private int bump(int input) {
        evaluations++;
        return input + 2;
    }

    public int compute(int input) {
        return ${expression};
    }

    public int duplicate(int input) {
        return ${expression};
    }

    public int assigned(int input) {
        int result = ${expression};
        return result;
    }

    public static void main(String[] args) {
        var fixture = new ${className}();
        System.out.print(fixture.compute(6) + ":" + fixture.duplicate(8) + ":" + fixture.assigned(7) + ":" + fixture.evaluations);
    }
}

class ${className}Parent { protected int inheritedValue; }
`;
  return {source,className,packageName,expression,expectedOutput:'16:20:18:3'};
}

function assertNamedBody(fixture,after,kind,name) {
  assert.match(after,new RegExp('return (?:this\\.)?'+name+';'));
  assert.ok(after.includes('public int duplicate(int input) {\n        return '+fixture.expression+';'));
  assert.equal((after.match(/bump\(input\) \* 2/g) || []).length,3);
  const declaration = `int ${name}`;
  if (kind === 'field') {
    assert.ok(after.includes('private '+declaration+';'));
    assert.match(after,new RegExp(`(?:this\\.)?${name} = bump\\(input\\) \\* 2;`));
  } else assert.ok(after.includes(declaration+' = '+fixture.expression+';'));
}

module.exports = { namedExtractionFixture,assertNamedBody };
