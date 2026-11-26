package fixture.boot;

import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.NoUniqueBeanDefinitionException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.support.BeanDefinitionBuilder;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(name="fixture.observed-injection.enabled",havingValue="true")
public class ObservedInjectionProbe {
    private final ConfigurableApplicationContext parent;
    private final AtomicInteger supplierCalls=new AtomicInteger();
    private AnnotationConfigApplicationContext positive;
    private AnnotationConfigApplicationContext members;

    ObservedInjectionProbe(ConfigurableApplicationContext parent){this.parent=parent;}

    private void define(BeanDefinitionRegistry registry,String suffix,String value){
        String name="runtime"+"Wire"+suffix;
        registry.registerBeanDefinition(name,BeanDefinitionBuilder.genericBeanDefinition(ObservedDynamicValue.class,()->{
            supplierCalls.incrementAndGet();
            return new ObservedDynamicValue(value);
        }).getBeanDefinition());
    }
    private AnnotationConfigApplicationContext context(){
        var context=new AnnotationConfigApplicationContext();
        context.setId("rocketbrain-runtime-wiring-child");
        context.setParent(parent);
        define(context,"Left","fixture-only-left-value");
        define(context,"Right","fixture-only-right-value");
        return context;
    }

    @GetMapping("/probe/observed-injection/qualified")
    public synchronized Map<String,String> qualified(){
        if(positive==null){
            var candidate=context();
            candidate.registerBean("wireConsumer",QualifiedWireConsumer.class);
            try{candidate.refresh();positive=candidate;}
            catch(RuntimeException failed){candidate.close();throw failed;}
        }
        return positive.getBean(QualifiedWireConsumer.class).values();
    }

    @GetMapping("/probe/observed-injection/ambiguous")
    public synchronized Map<String,Integer> ambiguous(){
        try(var candidate=context()){
            candidate.registerBean("wireConsumer",AmbiguousWireConsumer.class);
            try{candidate.refresh();}
            catch(RuntimeException failed){
                for(Throwable cause=failed;cause!=null;cause=cause.getCause()){
                    if(cause instanceof NoUniqueBeanDefinitionException nonUnique) return Map.of("candidates",nonUnique.getNumberOfBeansFound());
                }
                throw failed;
            }
            throw new IllegalStateException("Expected an ambiguous fixture constructor");
        }
    }

    @GetMapping("/probe/observed-injection/counters")
    public Map<String,Integer> counters(){return Map.of("supplierCalls",supplierCalls.get());}

    @GetMapping("/probe/observed-injection/members")
    public synchronized Map<String,Object> members(){
        if(members==null){
            var candidate=context();
            candidate.registerBean("memberConsumer",MemberWireConsumer.class);
            try{candidate.refresh();members=candidate;}
            catch(RuntimeException failed){candidate.close();throw failed;}
        }
        return members.getBean(MemberWireConsumer.class).values();
    }

    @GetMapping("/probe/observed-injection/ambiguous-member")
    public synchronized Map<String,Integer> ambiguousMember(){
        try(var candidate=context()){
            candidate.registerBean("memberConsumer",AmbiguousMemberWireConsumer.class);
            try{candidate.refresh();}
            catch(RuntimeException failed){
                for(Throwable cause=failed;cause!=null;cause=cause.getCause()){
                    if(cause instanceof NoUniqueBeanDefinitionException nonUnique)return Map.of("candidates",nonUnique.getNumberOfBeansFound());
                }
                throw failed;
            }
            throw new IllegalStateException("Expected an ambiguous fixture field");
        }
    }

    @PreDestroy
    public synchronized void close(){
        if(positive!=null){positive.close();positive=null;}
        if(members!=null){members.close();members=null;}
    }
}

record ObservedDynamicValue(String value){}

class QualifiedWireConsumer {
    private final ObservedDynamicValue first,second;
    QualifiedWireConsumer(@Qualifier("runtimeWireLeft") ObservedDynamicValue first,
                          @Qualifier("runtimeWireRight") ObservedDynamicValue second){
        this.first=first;this.second=second;
    }
    Map<String,String> values(){return Map.of("first",first.value(),"second",second.value());}
}

class AmbiguousWireConsumer {
    AmbiguousWireConsumer(ObservedDynamicValue unresolved){}
}

record ObservedAbsentValue(String value){}

class MemberWireConsumer {
    @Autowired @Qualifier("runtimeWireLeft")
    private ObservedDynamicValue field;

    @Autowired(required=false)
    private ObservedAbsentValue optional;

    @Autowired
    private Optional<ObservedAbsentValue> wrapped;

    @Autowired
    private ObservedDynamicValue[] vector;

    @Autowired @Qualifier("runtimeWireLeft")
    private Set<ObservedDynamicValue> filtered;

    private ObservedDynamicValue picked;
    private List<ObservedDynamicValue> group;
    private Map<String,ObservedDynamicValue> named;
    private boolean invokedOptional;

    @Autowired
    void assign(@Qualifier("runtimeWireLeft") ObservedDynamicValue first, List<ObservedDynamicValue> group,
                Map<String,ObservedDynamicValue> named, @Qualifier("runtimeWireRight") Optional<ObservedDynamicValue> selected){
        this.group=group;this.named=named;this.picked=selected.orElseThrow();
        if(first!=field)throw new IllegalStateException("Fixture bean identity differs");
    }

    @Autowired(required=false)
    void skipped(@Qualifier("runtimeWireLeft") ObservedDynamicValue available,ObservedAbsentValue missing){
        invokedOptional=true;
    }

    Map<String,Object> values(){
        return Map.of("field",field.value(),"picked",picked.value(),"members",group.size(),
            "mapKeys",named.keySet().stream().sorted().toList(),"optionalAbsent",optional==null,
            "wrappedAbsent",wrapped.isEmpty(),"optionalMethodSkipped",!invokedOptional,
            "arrayMembers",vector.length,"qualifiedSetMembers",filtered.size());
    }
}

class AmbiguousMemberWireConsumer {
    @Autowired ObservedDynamicValue competing;
}
