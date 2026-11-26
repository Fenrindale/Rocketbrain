package registry;

import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.BeanDefinitionRegistryPostProcessor;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext;
import org.springframework.boot.web.servlet.ServletRegistrationBean;
import org.springframework.context.ApplicationContextInitializer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.ImportBeanDefinitionRegistrar;
import org.springframework.core.Ordered;
import org.springframework.core.PriorityOrdered;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import rocketbrain.spring.BootServletRegistrationTrace;

public final class BootServletRegistryProbe {
    private static final List<String> ORDER = new ArrayList<>();
    private static final AtomicInteger CREATED = new AtomicInteger();
    private static final AtomicInteger CLOSED = new AtomicInteger();
    private static final IllegalStateException FAILURE = new IllegalStateException("selected provider failure");
    public record Selected(String mode) {}

    @Configuration(proxyBeanMethods = false)
    @Import(Imported.class)
    public static class App {
        @Bean public TomcatServletWebServerFactory webServer() throws Exception {
            var factory = new TomcatServletWebServerFactory(0);
            factory.setAddress(InetAddress.getByName("127.0.0.1"));
            return factory;
        }

        @Bean public ServletRegistrationBean<HttpServlet> endpoint() {
            return new ServletRegistrationBean<>(new HttpServlet() {
                @Override protected void doGet(HttpServletRequest request,HttpServletResponse response)
                        throws java.io.IOException {
                    var jdbc = new JdbcTemplate(new DriverManagerDataSource(
                        System.getenv("RB_COROUTINE_JDBC_URL"),System.getenv("RB_COROUTINE_JDBC_USER"),
                        System.getenv("RB_COROUTINE_JDBC_PASSWORD")));
                    response.getWriter().print(jdbc.queryForObject("SELECT VERSION()",String.class) + "|"
                        + jdbc.queryForObject("SELECT 42",Integer.class) + "|" + CREATED.get());
                }
            },"/registry-state");
        }

        @Bean public static PriorityRegistry priorityRegistry() { return new PriorityRegistry(); }
        @Bean public static OrderedRegistry orderedRegistry() { return new OrderedRegistry(); }
        @Bean(destroyMethod="close") public AutoCloseable lifecycle() { return () -> CLOSED.incrementAndGet(); }
    }

    public static final class Imported implements ImportBeanDefinitionRegistrar {
        @Override public void registerBeanDefinitions(AnnotationMetadata importingClass,BeanDefinitionRegistry registry) {
            ORDER.add("imported");
            var bean = new RootBeanDefinition(Selected.class,() -> {
                CREATED.incrementAndGet();
                return new Selected("lazy");
            });
            bean.setLazyInit(true);
            registry.registerBeanDefinition("ownedLazy",bean); // AUDITED_IMPORT_ORIGIN
        }
    }

    public static final class Init implements ApplicationContextInitializer<ConfigurableApplicationContext>, Ordered {
        private final String name;
        private final int order;
        Init(String name,int order) { this.name=name; this.order=order; }
        @Override public int getOrder() { return order; }
        @Override public void initialize(ConfigurableApplicationContext context) {
            ORDER.add(name);
            ((BeanDefinitionRegistry)context).registerBeanDefinition(name,new RootBeanDefinition(Object.class));
        }
    }

    public static final class PriorityRegistry implements BeanDefinitionRegistryPostProcessor, PriorityOrdered {
        @Override public int getOrder() { return 40; }
        @Override public void postProcessBeanDefinitionRegistry(BeanDefinitionRegistry registry) {
            ORDER.add("priority");
            registry.registerAlias("ownedLazy","stableAlias"); // AUDITED_PRIORITY_ORIGIN
        }
    }

    public static final class OrderedRegistry implements BeanDefinitionRegistryPostProcessor, Ordered {
        @Override public int getOrder() { return -10; }
        @Override public void postProcessBeanDefinitionRegistry(BeanDefinitionRegistry registry) {
            ORDER.add("ordered");
            registry.registerBeanDefinition("transientDefinition",new RootBeanDefinition(Object.class));
            registry.removeBeanDefinition("transientDefinition");
        }
    }

    private static SpringApplication application(ApplicationContextFactory factory) {
        var application = new SpringApplication(App.class);
        application.setWebApplicationType(WebApplicationType.SERVLET);
        application.setBannerMode(Banner.Mode.OFF);
        application.setLogStartupInfo(false);
        application.setRegisterShutdownHook(false);
        application.addInitializers(new Init("lateInit",900),new Init("earlyInit",200));
        if (factory!=null) application.setApplicationContextFactory(factory);
        return application;
    }

    private static String read(ConfigurableApplicationContext context) {
        try (var http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
            int port=((ServletWebServerApplicationContext)context).getWebServer().getPort();
            var reply=http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/registry-state"))
                .timeout(Duration.ofSeconds(5)).GET().build(),HttpResponse.BodyHandlers.ofString());
            if(reply.statusCode()!=200)throw new AssertionError(reply.statusCode());
            return reply.body();
        } catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    private static String launch(ApplicationContextFactory factory) {
        String result;
        try (var context=application(factory).run("--logging.level.root=ERROR")) {
            if (CREATED.get()!=0 || !ORDER.equals(List.of("earlyInit","lateInit","imported","priority","ordered"))) {
                throw new AssertionError(ORDER+" "+CREATED.get());
            }
            String before=read(context);
            var registry=(BeanDefinitionRegistry)context;
            registry.registerAlias("ownedLazy","lateAlias");
            registry.removeAlias("lateAlias");
            registry.registerBeanDefinition("lateDefinition",new RootBeanDefinition(Object.class));
            registry.removeBeanDefinition("lateDefinition"); // AUDITED_LATE_ORIGIN
            if (registry.isAlias("lateAlias") || registry.containsBeanDefinition("lateDefinition") ||
                registry.containsBeanDefinition("transientDefinition")) throw new AssertionError("registry lifecycle");
            if (!context.getBean("stableAlias",Selected.class).mode().equals("lazy") || CREATED.get()!=1) {
                throw new AssertionError("lazy supplier");
            }
            String after=read(context);
            if (!before.endsWith("|42|0") || !after.equals(before.substring(0,before.length()-1)+"1")) {
                throw new AssertionError("read-only servlet JDBC");
            }
            result=after;
        }
        if(CLOSED.get()!=1)throw new AssertionError("context did not close once");
        return String.join(",",ORDER)+"|"+result+"|"+CLOSED.get();
    }

    private static String fail(ApplicationContextFactory factory) {
        var application=application(factory);
        application.addInitializers(context -> {
            ((BeanDefinitionRegistry)context).registerBeanDefinition("beforeFailure",new RootBeanDefinition(Object.class));
            throw FAILURE;
        });
        application.run("--logging.level.root=OFF");
        throw new AssertionError("missing original failure");
    }

    private static void refuseAot(Path file) throws Exception {
        try {
            BootServletRegistrationTrace.observe(file,"AOT",factory -> {throw new AssertionError("entered AOT callback");});
            throw new AssertionError("AOT trace was not refused");
        } catch (IllegalStateException expected) {
            if (!expected.getMessage().contains("ordinary JVM runtime") || Files.exists(file)) throw expected;
        }
        System.out.println("BOOT_REGISTRY_AOT=refused");
    }

    public static void main(String[] args) throws Exception {
        String mode=args[0];
        Path trace=Path.of(args[1]).toAbsolutePath();
        if (mode.equals("aot")) {refuseAot(trace); return;}
        if (mode.equals("plain")) {System.out.println("BOOT_REGISTRY="+launch(null));return;}
        if (mode.equals("trace")) {
            System.out.println("BOOT_REGISTRY="+BootServletRegistrationTrace.observe(trace,"servlet runtime",BootServletRegistryProbe::launch));
            return;
        }
        try {
            if(mode.equals("fail-plain")) fail(null);
            else BootServletRegistrationTrace.observe(trace,"failed servlet runtime",BootServletRegistryProbe::fail);
            throw new AssertionError("missing failure");
        } catch(IllegalStateException expected) {
            if(expected!=FAILURE)throw expected;
            System.out.println("BOOT_REGISTRY_FAILURE=original");
        }
    }
}
