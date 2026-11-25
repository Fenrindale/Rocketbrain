'use strict';

function breakpointSource(packageName,className) {
  return [
    'package '+packageName+';',
    'import java.util.function.IntUnaryOperator;',
    'public class '+className+' extends '+className+'Base {',
    '    static final class Box { int value = 3; }',
    '    static int pick(Object item) { return 3; }',
    '    static int pick(String item) { return 4; }',
    '    public static void main(String[] args) {',
    '        '+className+' child = new '+className+'();',
    '        Box box = new Box();',
    '        int initial = 2; // FIELD_GATE',
    '        int first = box.value; // FIELD_READ',
    '        box.value = initial + first; // FIELD_WRITE',
    '        int second = child.inherited();',
    '        int third = pick((Object) "a") + pick("b");',
    '        IntUnaryOperator left = n -> n + 10; IntUnaryOperator right = n -> n + 20; // TWO_LAMBDAS',
    '        System.out.println(second + third + left.applyAsInt(1) + right.applyAsInt(1));',
    '    }',
    '}',
    ''
  ].join('\n');
}

function breakpointBase(packageName,className) {
  return 'package '+packageName+';\nclass '+className+'Base {\n    int inherited() { return 5; }\n}\n';
}

module.exports = { breakpointSource,breakpointBase };
