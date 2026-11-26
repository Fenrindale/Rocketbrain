package fixture.arc;

import java.util.concurrent.atomic.AtomicInteger;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.context.Dependent;
import jakarta.enterprise.inject.Produces;
import jakarta.inject.Named;
import io.quarkus.arc.lookup.LookupIfProperty;

@ApplicationScoped
public class Producers {
    private static final AtomicInteger calls=new AtomicInteger();

    @Produces @Dependent @Choice("fixture-private-left")
    ArcService left(){return result(21);}

    @Produces @Dependent @Choice("fixture-private-right")
    ArcService right(){return result(22);}

    @Produces @Dependent @Choice("fixture-private-conflict")
    ArcService conflictOne(){return result(31);}

    @Produces @Dependent @Choice("fixture-private-conflict")
    ArcService conflictTwo(){return result(32);}

    @Produces @Dependent @Named("fixture-private-gated")
    @LookupIfProperty(name="fixture.arc.gate",stringValue="yes")
    ArcService gated(){return result(33);}

    @Produces @Dependent @Named("fixture-private-field")
    ArcService field=new ArcService(41);

    @Produces @Dependent @Named("fixture-private-reflected")
    private ArcService reflected(){return result(51);}

    private static ArcService result(int value){calls.incrementAndGet();return new ArcService(value);}
    public static int calls(){return calls.get();}
}
