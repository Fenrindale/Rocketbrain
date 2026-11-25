'use strict';

const counts=Object.freeze({'unused-type-import':1,'empty-block-statement':1,'redundant-parentheses':5});

function cleanupFixture(packageName,className,{spring=false,eol='\n'}={}) {
  return [
    'package '+packageName+';',
    'import java.time.Instant;',
    'import java.time.LocalDate;',
    'import java.util.*;',
    'import static java.lang.Math.max;',
    ...(spring?['import org.springframework.stereotype.Component;']:[]),
    '/** Access the date at {@link LocalDate}. */',
    ...(spring?['@Component']:[]),
    'public class '+className+' {',
    '  public String evaluate(int value) {',
    '    ; // Keep this explanation.',
    '    final int total = ((value + 1));',
    '    if (value == 0);',
    '    for (; value < 0; value++);',
    '    List<Integer> values = List.of(total);',
    '    return(score((values.getFirst())) + ":" + score((0.5d)) + ":" + (2 + 3) * 4);',
    '  }',
    '  private int score(int value) { return max(value, 2); }',
    '  private double score(double value) { return max(value, 2.0d); }',
    '}', ''
  ].join(eol);
}

module.exports={cleanupFixture,counts};
