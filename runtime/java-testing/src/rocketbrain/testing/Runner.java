package rocketbrain.testing;

import java.io.BufferedWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** Owned adapter using the public JUnit Platform launcher and JaCoCo runtime API. */
public final class Runner {
    private static BufferedWriter events;
    private static Properties settings;
    private static String nonce;
    private static long sequence;
    private static final AtomicBoolean coverageSaved = new AtomicBoolean();
    private Runner() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("One private configuration URI is required.");
        Path config = Path.of(URI.create(args[0]));
        if (Files.size(config) > 1024 * 1024) throw new IllegalArgumentException("Configuration exceeds limit.");
        settings = new Properties();
        try (var input = Files.newInputStream(config)) { settings.load(input); }
        nonce = value("nonce");
        events = Files.newBufferedWriter(Path.of(URI.create(value("events"))), StandardCharsets.UTF_8, StandardOpenOption.APPEND);
        if (!value("coverageFile").isEmpty()) Runtime.getRuntime().addShutdownHook(new Thread(Runner::saveCoverage, "rocketbrain-test-coverage"));
        int exit = 0;
        try {
            String mode = value("mode");
            if (!Set.of("discover", "run").contains(mode)) throw new IllegalArgumentException("Unsupported execution mode.");
            NamedModuleTests named = value("testModule").isEmpty() ? null : NamedModuleTests.open();
            exit=value("framework").equals("testng")?TestNgAdapter.execute(mode,named):new JupiterAdapter(named).execute(mode);
        } catch (Throwable error) {
            emit(map("type","error","error",failure(error)));exit=2;
        } finally { saveCoverage(); events.close(); }
        System.exit(exit);
    }
    static Map<String,Object> failure(Throwable error) {
        StringWriter stack=new StringWriter();error.printStackTrace(new PrintWriter(stack));
        Map<String,Object> result=map("className",error.getClass().getName(),"message",cut(error.getMessage(),16384),"stack",cut(stack.toString(),65536));
        if (value("testModule").isEmpty() || !value("framework").equals("testng")) JupiterAdapter.comparison(error,result);
        if (error.getClass() == AssertionError.class) testNgTextComparison(error,result);
        result.put("frames",java.util.Arrays.stream(error.getStackTrace()).limit(128).map(frame->map("className",frame.getClassName(),"methodName",frame.getMethodName(),"fileName",frame.getFileName(),"line",Math.max(0,frame.getLineNumber()-1))).toList());return result;
    }
    static void setStringComparison(Map<String,Object> result,String kind,String expected,String actual) {
        setComparison(result,kind,expected==null?"null":expected,actual==null?"null":actual,
            expected==null?"null":"java.lang.String",actual==null?"null":"java.lang.String");
    }
    static void setComparison(Map<String,Object> result,String kind,String expected,String actual,String expectedType,String actualType) {
        if(expected==null||actual==null||expected.length()>16384||actual.length()>16384)return;
        result.put("comparisonKind",kind);result.put("expected",expected);result.put("actual",actual);
        if(expectedType!=null)result.put("expectedType",cut(expectedType,512));
        if(actualType!=null)result.put("actualType",cut(actualType,512));
    }
    private static void testNgTextComparison(Throwable error,Map<String,Object> result) {
        StackTraceElement[] frames=error.getStackTrace();
        if(frames.length<2||!frames[0].getClassName().equals("org.testng.Assert")||!frames[0].getMethodName().equals("fail")||
            !frames[1].getClassName().equals("org.testng.Assert")||!frames[1].getMethodName().equals("failNotEquals"))return;
        String message=error.getMessage(),prefix="expected [",separator="] but found [";
        if(message==null||message.length()>33000||!message.endsWith("]"))return;
        int left=message.indexOf(prefix),middle=message.indexOf(separator);
        if(left<0||left!=message.lastIndexOf(prefix)||middle<left+prefix.length()||middle!=message.lastIndexOf(separator)||
            (left>0&&message.charAt(left-1)!=' '))return;
        String expected=message.substring(left+prefix.length(),middle);
        String actual=message.substring(middle+separator.length(),message.length()-1);
        if(expected.indexOf('[')>=0||expected.indexOf(']')>=0||actual.indexOf('[')>=0||actual.indexOf(']')>=0)return;
        setComparison(result,"testng-text",expected,actual,null,null);
    }
    static void saveCoverage() {
        if(settings==null||value("coverageFile").isEmpty()||!coverageSaved.compareAndSet(false,true))return;
        try {
            Object agent=Class.forName("org.jacoco.agent.rt.RT").getMethod("getAgent").invoke(null);
            Class<?> api=Class.forName("org.jacoco.agent.rt.IAgent");
            byte[] data=(byte[])api.getMethod("getExecutionData",boolean.class).invoke(agent,false);
            Files.write(Path.of(URI.create(value("coverageFile"))),data,StandardOpenOption.CREATE_NEW);
        } catch(Throwable error) {try{emit(map("type","coverageError","errorClass",error.getClass().getName()));}catch(Throwable ignored){}}
    }
    static String value(String key) { return new String(Base64.getDecoder().decode(settings.getProperty(key,"")), StandardCharsets.UTF_8); }
    static int number(String key) {String value=value(key);return value.isEmpty()?0:Integer.parseInt(value);}
    static String cut(String value,int max) {return value==null?"":value.substring(0,Math.min(value.length(),max));}
    static Map<String,Object> map(Object... values) {Map<String,Object> result=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)result.put((String)values[i],values[i+1]);return result;}
    static synchronized void emit(Map<String,Object> event) {
        if(events==null)return;event.put("nonce",nonce);event.put("sequence",++sequence);event.put("at",Instant.now().toString());
        try {events.write(json(event));events.newLine();events.flush();}catch(java.io.IOException error){throw new java.io.UncheckedIOException(error);}
    }
    private static String json(Object value) {
        if(value==null)return "null";if(value instanceof Boolean||value instanceof Number)return value.toString();
        if(value instanceof Map<?,?> map){List<String> items=new ArrayList<>();map.forEach((key,item)->items.add(json(key.toString())+":"+json(item)));return "{"+String.join(",",items)+"}";}
        if(value instanceof Iterable<?> list){List<String> items=new ArrayList<>();for(Object item:list)items.add(json(item));return "["+String.join(",",items)+"]";}
        StringBuilder out=new StringBuilder("\"");for(char c:value.toString().toCharArray()){switch(c){case '"'->out.append("\\\"");case '\\'->out.append("\\\\");case '\n'->out.append("\\n");case '\r'->out.append("\\r");case '\t'->out.append("\\t");default->{if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}}}return out.append('"').toString();
    }
}
