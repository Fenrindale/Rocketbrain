package fixture.arc;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.eclipse.microprofile.config.spi.ConfigSource;

public final class GateSource implements ConfigSource {
    private static final String KEY="fixture.arc.gate";
    private static final AtomicInteger reads=new AtomicInteger();
    private static String value(){return System.getProperty("rb.arc.fixture.enabled","no");}
    @Override public Map<String,String> getProperties(){return Map.of(KEY,value());}
    @Override public Set<String> getPropertyNames(){return Set.of(KEY);}
    @Override public String getValue(String name){
        if(!KEY.equals(name))return null;
        reads.incrementAndGet();
        return value();
    }
    @Override public int getOrdinal(){return 290;}
    @Override public String getName(){return "fixture-private-conditional-source";}
    public static int reads(){return reads.get();}
}
