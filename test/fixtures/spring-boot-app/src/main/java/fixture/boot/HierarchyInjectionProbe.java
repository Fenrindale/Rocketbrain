package fixture.boot;

import jakarta.annotation.PreDestroy;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name="fixture.observed-injection.enabled",havingValue="true")
public final class HierarchyInjectionProbe {
    static final AtomicInteger factories = new AtomicInteger();
    private final ConfigurableApplicationContext application;
    private AnnotationConfigApplicationContext parent, child;

    HierarchyInjectionProbe(ConfigurableApplicationContext application) { this.application=application; }

    @GetMapping("/probe/observed-injection/hierarchy")
    public synchronized Map<String,Object> hierarchy() {
        if(child==null) {
            var upper=new AnnotationConfigApplicationContext();
            upper.setId("rocketbrain-observed-hierarchy");
            upper.setParent(application);
            upper.register(HierarchyParentDefinitions.class);
            var lower=new AnnotationConfigApplicationContext();
            lower.setId("rocketbrain-observed-hierarchy");
            lower.setParent(upper);
            lower.register(HierarchyChildDefinitions.class,HierarchyConstructor.class,HierarchyMembers.class);
            try{upper.refresh();lower.refresh();parent=upper;child=lower;}
            catch(RuntimeException failure){lower.close();upper.close();throw failure;}
        }
        HierarchyMembers members=child.getBean(HierarchyMembers.class);
        return Map.of("constructor",child.getBean(HierarchyConstructor.class).dependency.origin(),
            "fallback",members.parentOnly.origin(),"qualified",members.selected.origin(),
            "replacement",members.localReplacement.origin(),"hidden",members.hiddenBeforeQualification==null,
            "aggregate",members.choices.keySet().stream().sorted().toList());
    }

    @GetMapping("/probe/observed-injection/hierarchy-counters")
    public Map<String,Integer> counters() { return Map.of("factories",factories.get()); }

    @PreDestroy
    public synchronized void close() {
        if(child!=null){child.close();child=null;}
        if(parent!=null){parent.close();parent=null;}
    }
}

class HierarchyParentDefinitions {
    @Bean @Scope("prototype") HierarchyFallback hierarchyFallback() {
        HierarchyInjectionProbe.factories.incrementAndGet();
        return new HierarchyFallback("fixture-parent-fallback");
    }

    @Bean @Qualifier("east")
    HierarchyChoice parentEast() {
        HierarchyInjectionProbe.factories.incrementAndGet();
        return new HierarchyChoice("fixture-parent-qualified");
    }

    @Bean HierarchyChoice parentOther() { return new HierarchyChoice("fixture-parent-other"); }

    @Bean HierarchyReplacement hierarchyReplacement() { return new HierarchyReplacement("fixture-parent-shadowed"); }

    @Bean HierarchyMasked hierarchyMasked() { return new HierarchyMasked(); }

    @Bean HierarchyAggregate aggregateAncestor() { return new HierarchyAggregate("fixture-parent-aggregate"); }
}

class HierarchyChildDefinitions {
    @Bean HierarchyReplacement hierarchyReplacement() {
        HierarchyInjectionProbe.factories.incrementAndGet();
        return new HierarchyReplacement("fixture-child-replacement");
    }

    @Bean String hierarchyMasked() { return "fixture-child-different-type"; }

    @Bean HierarchyAggregate aggregateLocal() { return new HierarchyAggregate("fixture-child-aggregate"); }
}

record HierarchyFallback(String origin) {}
record HierarchyChoice(String origin) {}
record HierarchyReplacement(String origin) {}
record HierarchyMasked() {}
record HierarchyAggregate(String origin) {}

class HierarchyConstructor {
    final HierarchyFallback dependency;
    HierarchyConstructor(HierarchyFallback dependency) { this.dependency=dependency; }
}

class HierarchyMembers {
    @Autowired HierarchyFallback parentOnly;
    @Autowired @Qualifier("east") HierarchyChoice selected;
    @Autowired HierarchyReplacement localReplacement;
    @Autowired(required=false) HierarchyMasked hiddenBeforeQualification;
    @Autowired Map<String,HierarchyAggregate> choices;
}
