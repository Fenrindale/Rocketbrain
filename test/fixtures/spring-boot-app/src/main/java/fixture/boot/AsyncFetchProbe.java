package fixture.boot;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;
import org.springframework.web.context.request.async.WebAsyncTask;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@RestController
class AsyncFetchProbe {
    static final String CALLABLE = "/probe/hibernate-fetch/callable";
    private final FetchProbe fetch;
    private final AtomicReference<Gate> current = new AtomicReference<>(new Gate());

    private record Gate(CountDownLatch workerEntered, CountDownLatch controlRead) {
        Gate() { this(new CountDownLatch(1), new CountDownLatch(1)); }
    }

    AsyncFetchProbe(FetchProbe fetch) { this.fetch = fetch; }

    @GetMapping(CALLABLE)
    Callable<Map<String,Integer>> callable() {
        fetch.observeMarker();
        Gate gate = current.get();
        return () -> {
            gate.workerEntered.countDown();
            try {
                if (!gate.controlRead.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("Missing concurrent test control");
                return fetch.lazy();
            } finally { current.compareAndSet(gate, new Gate()); }
        };
    }

    @GetMapping("/probe/hibernate-fetch/concurrent-join")
    Map<String,Integer> concurrentJoin() throws InterruptedException {
        Gate gate = current.get();
        if (!gate.workerEntered.await(8, TimeUnit.SECONDS)) throw new IllegalStateException("Missing Callable test worker");
        try { return fetch.joined(); }
        finally { gate.controlRead.countDown(); }
    }

    @GetMapping("/probe/hibernate-fetch/deferred")
    DeferredResult<Map<String,Integer>> deferred() {
        fetch.observeMarker();
        var deferred = new DeferredResult<Map<String,Integer>>(8_000L);
        Thread.startVirtualThread(() -> {
            try { deferred.setResult(fetch.lazy()); }
            catch (RuntimeException failed) { deferred.setErrorResult(failed); }
        });
        return deferred;
    }

    @GetMapping("/probe/hibernate-fetch/callable-timeout")
    WebAsyncTask<Map<String,Boolean>> timeout() {
        var task = new WebAsyncTask<Map<String,Boolean>>(1_500L, () -> {
            fetch.observeMarker();
            Thread.sleep(4_000L);
            return Map.of("timedOut", false);
        });
        task.onTimeout(() -> Map.of("timedOut", true));
        return task;
    }
}

@Configuration(proxyBeanMethods=false)
class AsyncFetchProbeConfig implements WebMvcConfigurer {
    private final FetchProbe fetch;
    AsyncFetchProbeConfig(FetchProbe fetch) { this.fetch = fetch; }

    @Override public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
                if (request.getDispatcherType() == DispatcherType.ASYNC) fetch.observeMarker();
                return true;
            }
        }).addPathPatterns(AsyncFetchProbe.CALLABLE);
    }
}
