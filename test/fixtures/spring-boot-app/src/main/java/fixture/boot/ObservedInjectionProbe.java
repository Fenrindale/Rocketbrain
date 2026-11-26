package fixture.boot;

import jakarta.annotation.PreDestroy;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.NoUniqueBeanDefinitionException;
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

    @PreDestroy
    public synchronized void close(){if(positive!=null){positive.close();positive=null;}}
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
