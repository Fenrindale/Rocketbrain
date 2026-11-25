'use strict';

function conversionSource(packageName,className) {
  return [
    'package '+packageName+';',
    'import java.util.function.IntUnaryOperator;',
    'public class '+className+' {',
    '    public static int lambda(int value) {',
    '        IntUnaryOperator action = input -> input + 2;',
    '        return action.applyAsInt(value);',
    '    }',
    '    public static int anonymous(int value) {',
    '        IntUnaryOperator action = new IntUnaryOperator() {',
    '            @Override public int applyAsInt(int input) { return input + 4; }',
    '        };',
    '        return action.applyAsInt(value);',
    '    }',
    '    public static int loop(int[] values) {',
    '        int sum = 0;',
    '        for (int i = 0; i < values.length; i++) { sum += values[i]; }',
    '        return sum;',
    '    }',
    '    static boolean escaped() {',
    '        IntUnaryOperator escaped = n -> n + 1;',
    '        return escaped == escaped;',
    '    }',
    '    static int captured() {',
    '        IntUnaryOperator captured = n -> n + 1;',
    '        java.util.function.IntSupplier caller = () -> captured.applyAsInt(3);',
    '        return caller.getAsInt();',
    '    }',
    '    static int receiver() {',
    '        IntUnaryOperator self = new IntUnaryOperator() {',
    '            @Override public int applyAsInt(int input) { return this.hashCode(); }',
    '        };',
    '        return self.applyAsInt(3);',
    '    }',
    '    static void writes(int[] values) {',
    '        for (int i = 0; i < values.length; i++) { values[i] += 1; }',
    '    }',
    '    public static void main(String[] args) {',
    '        System.out.print(lambda(3) + ":" + anonymous(5) + ":" + loop(new int[]{1,3,-2}) + ":" + loop(new int[]{}));',
    '    }',
    '}',''
  ].join('\n');
}

module.exports = { conversionSource };
