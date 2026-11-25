package rocketbrain.observer;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Recognizes only the SELECT graph syntax accepted at the console's input and JDBC boundaries. */
final class ConsoleSelectShape {
    private static final Set<String> OPERATORS = Set.of("union","intersect","except");
    private static final Set<String> QUERY_WORDS = Set.of("select","with","union","intersect","except");
    private static final Set<String> FROM_END = Set.of("where","group","having","order","limit");
    private static final Set<String> NON_NAMES = Set.of("with","select","from","join","where","as","all","distinct",
        "union","intersect","except","recursive","search","cycle","materialized","order","limit","lateral");
    private final List<String> tokens;
    private final int[] ends;
    private final Set<Integer> syntax = new HashSet<>(), introductions = new HashSet<>();
    private final boolean sql;
    private final String refusal;
    private int graphs, operators, relations;

    private ConsoleSelectShape(List<String> tokens,boolean sql,String refusal) {
        this.tokens = tokens;
        this.sql = sql;
        this.refusal = refusal;
        this.ends = new int[tokens.size()];
        ArrayDeque<Integer> opens = new ArrayDeque<>();
        for (int i=0;i<tokens.size();i++) {
            if (token(i).equals("(")) {
                opens.push(i);
                expect(opens.size()<=12);
            } else if (token(i).equals(")")) {
                expect(!opens.isEmpty());
                ends[opens.pop()] = i;
            }
        }
        expect(opens.isEmpty());
    }

    static ConsoleSelectShape parse(List<String> tokens,boolean sql,String refusal) {
        ConsoleSelectShape shape = new ConsoleSelectShape(tokens,sql,refusal);
        shape.query(0,tokens.size(),0,true);
        for (int i=0;i<tokens.size();i++)
            if (QUERY_WORDS.contains(shape.token(i))) shape.expect(shape.syntax.contains(i));
        return shape;
    }

    boolean structuralParenthesis(int index) { return introductions.contains(index); }
    boolean advanced() { return operators>0 || relations>0; }

    private void query(int start,int end,int depth,boolean advancedAllowed) {
        expect(start<end && depth<=8 && ++graphs<=32);
        if (token(start).equals("with")) {
            expect(advancedAllowed || sql);
            syntax.add(start);
            start = commonTables(start+1,end,depth);
        }
        for (int i=start, arm=start;i<=end;i++) {
            if (i<end && token(i).equals("(")) { i=ends[i]; continue; }
            if (i!=end && !OPERATORS.contains(token(i))) continue;
            operand(arm,i,depth,advancedAllowed);
            if (i==end) break;
            expect((advancedAllowed || sql) && ++operators<=10);
            syntax.add(i);
            arm = i+1;
            if (token(arm).equals("all") || token(arm).equals("distinct")) arm++;
            i = arm-1;
        }
    }

    private int commonTables(int start,int end,int depth) {
        Set<String> names = new HashSet<>();
        for (int at=start;at<end;) {
            String name=token(at++);
            expect(identifier(name) && !NON_NAMES.contains(name) && names.add(name) && ++relations<=12);
            if (sql && token(at).equals("(")) at=columnNames(at,end);
            expect(token(at++).equals("as") && token(at).equals("("));
            int open=at, close=ends[at];
            expect(close<end);
            for (int i=open+1;i<close;i++) {
                if (token(i).equals(name) && (token(i-1).equals("from") || token(i-1).equals("join") || token(i-1).equals(",")))
                    throw new ConsoleQuery.Refusal(refusal);
            }
            introductions.add(open);
            query(open+1,close,depth+1,true);
            at=close+1;
            if (!token(at).equals(",")) return at;
            at++;
        }
        throw new ConsoleQuery.Refusal(refusal);
    }

    private void operand(int start,int end,int depth,boolean advancedAllowed) {
        expect(start<end);
        if (token(start).equals("(")) {
            int close=ends[start];
            expect(close<end && (close+1==end || token(close+1).equals("order") || sql && token(close+1).equals("limit")));
            introductions.add(start);
            query(start+1,close,depth+1,advancedAllowed);
            walkGroups(close+1,end,depth,false);
            return;
        }
        expect(token(start).equals("select"));
        syntax.add(start);
        boolean from=false, inFrom=false;
        for (int i=start+1;i<end;i++) {
            if (token(i).equals("(")) {
                int close=ends[i];
                expect(close<end);
                String previous=token(i-1);
                boolean fromRoot=previous.equals("from") || previous.equals("join") || inFrom && previous.equals(",");
                boolean derived=fromRoot && startsQuery(i+1,close);
                if (derived) expect((advancedAllowed || sql) && ++relations<=12);
                group(i,close,depth,fromRoot);
                i=close;
                if (sql && derived) {
                    int alias=i+(token(i+1).equals("as")?2:1);
                    if (identifier(token(alias)) && !NON_NAMES.contains(token(alias)) && token(alias+1).equals("("))
                        i=columnNames(alias+1,end)-1;
                }
            } else if (token(i).equals("from")) { from=true; inFrom=true; }
            else if (FROM_END.contains(token(i))) inFrom=false;
        }
        expect(from);
    }

    private int columnNames(int open,int end) {
        int close=ends[open];
        introductions.add(open);
        expect(close>open+1 && close<end && (close-open)%2==0);
        for (int i=open+1;i<close;i++) expect((i-open)%2==1?identifier(token(i)):token(i).equals(","));
        return close+1;
    }

    private void walkGroups(int start,int end,int depth,boolean derived) {
        for(int i=start;i<end;i++) if(token(i).equals("(")) {
            int close=ends[i];
            expect(close<end);
            group(i,close,depth,derived);
            i=close;
        }
    }

    private void group(int open,int close,int depth,boolean derived) {
        expect(depth<=12);
        if (startsQuery(open+1,close)) {
            if (derived) introductions.add(open);
            query(open+1,close,depth+1,derived);
        } else walkGroups(open+1,close,depth+1,false);
    }

    private boolean startsQuery(int start,int end) {
        while (start<end && token(start).equals("(")) start++;
        return start<end && (token(start).equals("select") || token(start).equals("with"));
    }

    private String token(int index) { return index>=0 && index<tokens.size()?tokens.get(index):""; }
    private static boolean identifier(String value) { return value.matches("[a-z_][a-z_0-9]*|`[a-z_][a-z_0-9]*`"); }
    private void expect(boolean condition) { if (!condition) throw new ConsoleQuery.Refusal(refusal); }
}
