'use strict';

function historyTestSources(packageName,names) {
  const {junit,testng,vintage}=names;
  const files={
    [junit+'.java']:`package ${packageName};
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
public class ${junit} {
  @Test public void amount() {
    if (Boolean.getBoolean("rb.history.fail")) assertEquals("before\\nexpected amount", "before\\nactual amount");
  }
  @Test public void unaffected() { assertEquals(2, 2); }
}
`,
    [testng+'.java']:`package ${packageName};
import org.testng.Assert;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;
import org.opentest4j.AssertionFailedError;
public class ${testng} {
  @DataProvider public Object[][] rows() { return new Object[][] {{7}, {9}}; }
  @Test(dataProvider="rows") public void typed(int number) {
    if (number == 9 && Boolean.getBoolean("rb.history.fail")) {
      throw new AssertionFailedError("Inventory comparison", 44, 52L);
    }
  }
  @Test public void stock() {
    if (Boolean.getBoolean("rb.history.fail")) Assert.assertEquals("actual inventory", "expected inventory");
  }
  @Test public void ambiguous() {
    if (Boolean.getBoolean("rb.history.fail")) Assert.assertEquals("unsafe [actual]", "unsafe [expected]");
  }
}
`
  };
  if(vintage)files[vintage+'.java']=`package ${packageName};
import org.junit.Test;
import static org.junit.Assert.assertEquals;
public class ${vintage} {
  @Test public void vintageComparison() {
    if (Boolean.getBoolean("rb.history.fail")) assertEquals("test\\nlegacy expected", "test\\nlegacy actual");
  }
}
`;
  return files;
}

module.exports={historyTestSources};
