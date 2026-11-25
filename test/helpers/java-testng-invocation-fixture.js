'use strict';

const assert = require('node:assert/strict');

function testNgInvocationSource(namespace, className) {
  return `package ${namespace};

import org.testng.Assert;
import org.testng.IRetryAnalyzer;
import org.testng.ITestResult;
import org.testng.IDataProviderInterceptor;
import org.testng.IDataProviderMethod;
import org.testng.ITestContext;
import org.testng.ITestNGMethod;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Listeners;
import org.testng.annotations.Test;

@Listeners(${className}.ReorderRows.class)
public final class ${className} {
    private final String first = new String("duplicate");
    private final String second = new String("duplicate");
    private int attempts;

    @DataProvider(parallel = true)
    public Object[][] repeatedRows() {
        return new Object[][] {{first}, {"other"}, {second}};
    }

    public static final class ReorderRows implements IDataProviderInterceptor {
        @Override public java.util.Iterator<Object[]> intercept(java.util.Iterator<Object[]> rows, IDataProviderMethod provider,
                ITestNGMethod method, ITestContext context) {
            if (!method.getMethodName().equals("duplicate") || !Boolean.getBoolean("rocketbrain.fixture.changedOrder")) return rows;
            var changed = new java.util.ArrayList<Object[]>();
            rows.forEachRemaining(changed::add);
            java.util.Collections.swap(changed, 1, 2);
            return changed.iterator();
        }
    }

    @Test(dataProvider = "repeatedRows")
    public void duplicate(String input) throws java.io.IOException {
        String marker = input == first ? "TESTNG_ROW_FIRST" : input == second ? "TESTNG_ROW_SECOND" : "TESTNG_ROW_OTHER";
        System.out.println(marker);
        String file = System.getProperty("rocketbrain.fixture.markerPath");
        if (file != null) java.nio.file.Files.writeString(java.nio.file.Path.of(file), marker + "\\n",
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
    }

    @DataProvider
    public Object[][] retryInput() { return new Object[][] {{42}}; }

    public static final class RetryOnce implements IRetryAnalyzer {
        private int retries;
        @Override public boolean retry(ITestResult result) { return retries++ == 0; }
    }

    @Test(dataProvider = "retryInput", retryAnalyzer = RetryOnce.class)
    public void retry(int value) {
        System.out.println("TESTNG_RETRY_ATTEMPT:" + ++attempts);
        Assert.assertTrue(value == 42 && attempts > 1 && !Boolean.getBoolean("rocketbrain.fixture.retryFails"), "owned retry fixture");
    }
}
`;
}

function assertObservedInvocations(project) {
  assert.equal(project.state, 'completed', JSON.stringify(project.errors));
  assert.equal(project.summary.testsSucceeded, 4);
  assert.equal(project.summary.testsStarted, 4);
  assert.equal(project.summary.testsFound, 4);
  assert.equal(project.summary.testAttempts, 5);
  assert.equal(project.summary.testsSkipped, 0);
  assert.equal(project.summary.retriesScheduled, 1);
  const duplicates = project.tests.filter(test => test.methodName === 'duplicate' && test.kind === 'test')
    .sort((first, second) => first.providerIndex - second.providerIndex);
  assert.deepEqual(duplicates.map(test => test.providerIndex), [0, 1, 2]);
  assert.ok(duplicates.every(test => test.rerunnable));
  assert.deepEqual(duplicates.map(test => test.providerOccurrence), [0, 0, 1]);
  assert.equal(new Set(duplicates.map(test => test.id)).size, 3);
  assert.match(duplicates[0].id, /\/\[rows:[a-f0-9]{64}:0\]$/);
  assert.match(duplicates[2].id, /\/\[rows:[a-f0-9]{64}:2\]$/);
  const retry = project.tests.find(test => test.methodName === 'retry' && test.kind === 'test');
  assert.ok(retry?.rerunnable);
  assertRetry(project, retry.id, 'passed');
  return { duplicate: duplicates[2], retry };
}

function assertRetry(project, id, terminal) {
  const one = project.events.filter(event => event.test?.id === id);
  assert.deepEqual(one.filter(event => event.type === 'started').map(event => event.attempt), [1, 2]);
  assert.deepEqual(one.filter(event => event.type === 'retry').map(event => event.attempt), [1]);
  const finished = one.filter(event => event.type === 'finished');
  assert.deepEqual(finished.map(event => [event.attempt, event.state]), [[2, terminal]]);
  assert.equal(one.some(event => event.type === 'skipped'), false);
}

function assertOnlySelectedRow(project, selected) {
  assert.equal(project.state, 'completed', JSON.stringify(project.errors));
  assert.equal(project.summary.testsSucceeded, 1);
  assert.equal(project.summary.testsFound, 1);
  assert.match(project.output, /TESTNG_ROW_SECOND/);
  assert.doesNotMatch(project.output, /TESTNG_ROW_FIRST|TESTNG_ROW_OTHER|TESTNG_RETRY_ATTEMPT/);
  const started = project.events.filter(event => event.type === 'started' && event.test?.kind === 'test');
  assert.deepEqual(started.map(event => event.test.id), [selected.id]);
  assert.equal(started[0].test.providerIndex, 2);
}

module.exports = { testNgInvocationSource, assertObservedInvocations, assertRetry, assertOnlySelectedRow };
