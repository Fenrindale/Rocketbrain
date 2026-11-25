'use strict';

const output = '210703/Z:object;/A:string;C:string;/ij/0/array-null';
const arrayLoop = 'for (int index = 0; index < values.length; index++)';
const referenceLoop = 'for (int row = 0; row < codes.length; row++)';
const copiedListLoop = 'for (int index = 0; index < entries.size(); ++index)';
const literalListLoop = 'for (int i = 0; i < letters.size(); i++)';
const negativeLoops = [
  'for (int i = 0; i < indexed.length; i++)',
  'for (int i = 0; i < changed.length; i++)',
  'for (int i = 0; i < late.length; i++)',
  'for (int i = 0; i < custom.size(); i++)',
  'for (int i = 0; i < this.field.length; i++)',
  'for (int i = 0; i < bad.length; i++)',
  'for (int i = 0; i < commented.length; /* keep */ i++)'
];

function enhancedIterationSource(namespace,name,{spring = false} = {}) {
  return [
    'package '+namespace+';',
    'import java.util.List;',
    ...(spring ? ['import org.springframework.jdbc.core.JdbcTemplate;',
      'import org.springframework.jdbc.datasource.DriverManagerDataSource;'] : []),
    'public final class '+name+' {',
    '    private int[] field;',
    '    static int array(int[] values, int seed) {',
    '        int total = 0;',
    '        traverse: '+arrayLoop+' {',
    '            // Keep this comment and all control flow.',
    '            final var value = values[index];',
    '            if (value == seed) values[2] = 7;',
    '            if (value == 0) continue traverse;',
    '            if (value == 4) break traverse;',
    '            total = total * 100 + value;',
    '        }',
    '        return total;',
    '    }',
    '    static String referenceArray(String[] codes) {',
    '        var result = new StringBuilder();',
    '        '+referenceLoop+' {',
    '            final CharSequence code = codes[row];',
    '            if (code == null) continue;',
    '            result.append(render(code));',
    '        }',
    '        return result.toString();',
    '    }',
    '    static String copiedList() {',
    '        final List<String> entries = List.copyOf(List.of("A", "", "C", "stop", "L"));',
    '        var result = new StringBuilder();',
    '        '+copiedListLoop+' {',
    '            final String label = entries.get(index); // Preserve this trailing comment.',
    '            if (label.isEmpty()) continue;',
    '            if (label.equals("stop")) break;',
    '            result.append(render(label));',
    '        }',
    '        return result.toString();',
    '    }',
    '    static String literalList() {',
    '        final var letters = List.of("i", "j");',
    '        var result = new StringBuilder();',
    '        '+literalListLoop+' { var letter = letters.get(i); result.append(letter); }',
    '        return result.toString();',
    '    }',
    '    static String render(String name) { return name + ":string;"; }',
    '    static String render(Object value) { return value + ":object;"; }',
    '    int negatives(int[] indexed, int[] changed, int[] late, List<String> custom, int[] bad, int[] commented) {',
    '        int total = 0;',
    '        '+negativeLoops[0]+' { int value = indexed[i]; total += value * i; }',
    '        '+negativeLoops[1]+' { int value = changed[i]; changed = new int[0]; total += value; }',
    '        '+negativeLoops[2]+' { if (i == 0) late[0] = 5; int value = late[i]; total += value; }',
    '        '+negativeLoops[3]+' { String value = custom.get(i); total += value.length(); }',
    '        '+negativeLoops[4]+' { int value = this.field[i]; total += value; }',
    '        '+negativeLoops[5]+' { int value = bad[i], extra = 2; total += value + extra; }',
    '        '+negativeLoops[6]+' { int value = commented[i]; total += value; }',
    '        return total;',
    '    }',
    '    public static void main(String[] args) {',
    ...(spring ? [
      '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_ENHANCED_JDBC_URL"),',
      '            System.getenv("RB_ENHANCED_JDBC_USER"), System.getenv("RB_ENHANCED_JDBC_PASSWORD")));',
      '        int seed = jdbc.queryForObject("SELECT 21", Integer.class);',
      '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|");'
    ] : ['        int seed = 21;']),
    '        System.out.print(array(new int[]{seed, 0, 2, 3, 4, 99}, seed) + "/" + referenceArray(new String[]{null, "Z"}) + "/" + copiedList() + "/" +',
    '            literalList() + "/" + array(new int[0], seed));',
    '        try { array(null, seed); } catch (NullPointerException checked) { System.out.print("/array-null"); }',
    '    }',
    '}', ''
  ].join('\n');
}

module.exports = { output,arrayLoop,referenceLoop,copiedListLoop,literalListLoop,negativeLoops,enhancedIterationSource };
