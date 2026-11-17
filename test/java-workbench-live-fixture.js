'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const MAIN=`package fixture.daily;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
public class Main {
  public static void main(String[] args) throws Exception {
    int port=Integer.parseInt(System.getenv().getOrDefault("RB_DAILY_PORT","0"));
    String nonce=System.getenv().getOrDefault("RB_DAILY_NONCE","daily");
    HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",port),0);
    server.createContext("/daily",exchange->{byte[] value=nonce.getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,value.length);exchange.getResponseBody().write(value);exchange.close();});
    server.start();
    System.out.println("Rocketbrain managed daily fixture is ready.");
  }
}
`;
function create(parent){const id=crypto.randomBytes(6).toString('hex'),folder=path.join(parent,id),maven=path.join(folder,'maven'),gradle=path.join(folder,'gradle');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'owner.json'),JSON.stringify({kind:'RocketbrainJavaWorkbenchFixture-v18',id,createdAt:new Date().toISOString()}));for(const root of [maven,gradle]){const src=path.join(root,'src','main','java','fixture','daily');fs.mkdirSync(src,{recursive:true});fs.writeFileSync(path.join(src,'Main.java'),MAIN);}fs.writeFileSync(path.join(maven,'pom.xml'),`<project><modelVersion>4.0.0</modelVersion><groupId>fixture.daily</groupId><artifactId>daily-maven-${id}</artifactId><version>1.0.0</version><properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version></plugin></plugins></build></project>`);fs.writeFileSync(path.join(gradle,'settings.gradle'),`rootProject.name='daily-gradle-${id}'\n`);fs.writeFileSync(path.join(gradle,'build.gradle'),`plugins { id 'java'; id 'application' }\napplication { mainClass='fixture.daily.Main' }\ntasks.register('dailyProbe') { group='verification'; description='Owned daily task fixture'; doLast { println 'DAILY_TASK_OK' } }\n`);return{kind:'RocketbrainJavaWorkbenchFixture-v18',id,folder,maven,gradle,mavenUri:pathToFileURL(maven).href,gradleUri:pathToFileURL(gradle).href,source:path.join(gradle,'src','main','java','fixture','daily','Main.java'),mainClass:'fixture.daily.Main',uri:root=>pathToFileURL(root).href};}
module.exports={create,MAIN};
