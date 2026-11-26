package quarkusconfigfixture;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.eclipse.microprofile.config.spi.ConfigSource;

public final class FixtureSource implements ConfigSource {
    private static final String PROPERTY="sample.custom-label";
    private static final String RECORD="fixture-private-custom-source-value";
    private static final AtomicInteger counts=new AtomicInteger();
    @Override public Map<String,String> getProperties(){return Map.of(PROPERTY,RECORD);}
    @Override public Set<String> getPropertyNames(){return Set.of(PROPERTY);}
    @Override public String getValue(String name){
        if(!PROPERTY.equals(name))return null;
        counts.incrementAndGet();
        return RECORD;
    }
    @Override public int getOrdinal(){return 280;}
    @Override public String getName(){return "fixture-private-custom-source-name";}
    public static int lookups(){return counts.get();}
}
