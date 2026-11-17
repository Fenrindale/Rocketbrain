package rocketbrain.testing;

import java.nio.file.Path;
import java.nio.file.Files;
import java.net.URI;
import java.util.Properties;
import java.util.Base64;
import java.nio.charset.StandardCharsets;
import org.jacoco.core.tools.ExecFileLoader;

/** Uses JaCoCo's public OR-merge API without native command-line path limits. */
public final class CoverageFiles {
    private CoverageFiles() {}
    public static void main(String[] args) throws Exception {
        if(args.length!=1)throw new IllegalArgumentException("One private merge config URI required.");
        Path file=Path.of(URI.create(args[0]));if(Files.size(file)>1024*1024)throw new IllegalArgumentException("Config limit.");
        Properties values=new Properties();try(var input=Files.newInputStream(file)){values.load(input);}
        int count=Integer.parseInt(value(values,"count"));if(count<1||count>2002)throw new IllegalArgumentException("Merge input limit.");
        ExecFileLoader loader=new ExecFileLoader();
        for(int index=0;index<count;index++)loader.load(Path.of(URI.create(value(values,"file."+index))).toFile());
        loader.save(Path.of(URI.create(value(values,"output"))).toFile(),false);
    }
    private static String value(Properties values,String key){return new String(Base64.getDecoder().decode(values.getProperty(key,"")),StandardCharsets.UTF_8);}
}
