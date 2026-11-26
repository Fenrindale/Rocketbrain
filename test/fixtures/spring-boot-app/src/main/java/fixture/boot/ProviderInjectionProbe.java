package fixture.boot;

import jakarta.annotation.PreDestroy;
import jakarta.inject.Provider;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.NoUniqueBeanDefinitionException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Fallback;
import org.springframework.context.annotation.Lazy;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name="fixture.observed-injection.enabled",havingValue="true")
public final class ProviderInjectionProbe {
    static final AtomicInteger prototypes=new AtomicInteger();
    static final AtomicInteger singletons=new AtomicInteger();
    private final AtomicInteger callbacks=new AtomicInteger();
    private AnnotationConfigApplicationContext parent, child;

    @GetMapping("/probe/observed-injection/provider-prepare")
    public synchronized Map<String,Object> prepare() {
        if(child==null){
            var upper=new AnnotationConfigApplicationContext();
            upper.setId("fixture-provider-parent");
            upper.register(ProviderParentDefinitions.class);
            var lower=new AnnotationConfigApplicationContext();
            lower.setId("fixture-provider-child");
            lower.setParent(upper);
            lower.register(ProviderLocalDefinitions.class,ProviderConsumer.class);
            try{upper.refresh();lower.refresh();parent=upper;child=lower;}
            catch(RuntimeException failure){lower.close();upper.close();throw failure;}
        }
        return counters();
    }

    @GetMapping("/probe/observed-injection/provider-resolve")
    public synchronized Map<String,Object> resolve() {
        var consumer=child.getBean(ProviderConsumer.class);
        String ambiguous;
        try{consumer.ambiguous.getIfAvailable();ambiguous="unexpected";}
        catch(NoUniqueBeanDefinitionException observed){ambiguous="ambiguous";}
        return Map.of("prototype",consumer.delayed().origin(),"qualified",consumer.qualified.getIfAvailable().origin(),
            "missing",consumer.missing.getIfAvailable()==null,"ambiguous",ambiguous,"jsr",consumer.jsr.get().origin());
    }

    @GetMapping("/probe/observed-injection/provider-cached")
    public synchronized Map<String,Object> cached() {
        return Map.of("origin",child.getBean(ProviderConsumer.class).cached.getObject().origin());
    }

    @GetMapping("/probe/observed-injection/provider-supplier")
    public synchronized Map<String,Object> supplier() {
        var supplied=child.getBean(ProviderConsumer.class).missing.getIfAvailable(()->{
            callbacks.incrementAndGet();
            return ()->"caller-only-provider-fallback";
        });
        return Map.of("origin",supplied.origin());
    }

    @GetMapping("/probe/observed-injection/provider-counters")
    public Map<String,Object> counters() {
        return Map.of("prototypes",prototypes.get(),"singletons",singletons.get(),"callbacks",callbacks.get());
    }

    @PreDestroy synchronized void shutdown(){
        if(child!=null)child.close();
        if(parent!=null)parent.close();
    }
}

interface ProviderDelayed { String origin(); }
interface ProviderQualified { String origin(); }
interface ProviderMissing { String origin(); }
interface ProviderAmbiguous { String origin(); }
interface ProviderJsr { String origin(); }
interface ProviderCached { String origin(); }

class ProviderParentDefinitions {
    @Bean @Fallback @Scope("prototype")
    ProviderDelayed providerDelayedAncestor() {
        ProviderInjectionProbe.prototypes.incrementAndGet();
        return ()->"fixture-provider-delayed";
    }

    @Bean @Scope("prototype")
    ProviderQualified providerEast() {
        ProviderInjectionProbe.prototypes.incrementAndGet();
        return ()->"fixture-provider-east";
    }
}

class ProviderLocalDefinitions {
    @Bean @Scope("prototype") ProviderAmbiguous providerChoiceOne() {
        ProviderInjectionProbe.prototypes.incrementAndGet();
        return ()->"never-choice-one";
    }
    @Bean @Scope("prototype") ProviderAmbiguous providerChoiceTwo() {
        ProviderInjectionProbe.prototypes.incrementAndGet();
        return ()->"never-choice-two";
    }
    @Bean @Scope("prototype") ProviderJsr providerJsr() {
        ProviderInjectionProbe.prototypes.incrementAndGet();
        return ()->"fixture-provider-jsr";
    }
    @Bean @Lazy ProviderCached providerCached() {
        ProviderInjectionProbe.singletons.incrementAndGet();
        return ()->"fixture-provider-cached";
    }
}

class ProviderConsumer {
    private final ObjectProvider<ProviderDelayed> first;
    ProviderConsumer(ObjectProvider<ProviderDelayed> first) { this.first=first; }
    ProviderDelayed delayed() { return first.getObject(); }

    @Autowired @Qualifier("providerEast") ObjectProvider<ProviderQualified> qualified;
    @Autowired ObjectProvider<ProviderMissing> missing;
    @Autowired ObjectProvider<ProviderAmbiguous> ambiguous;
    @Autowired Provider<ProviderJsr> jsr;
    @Autowired ObjectProvider<ProviderCached> cached;
}
